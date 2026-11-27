use std::collections::{HashMap, HashSet, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use async_trait::async_trait;
use futures_util::StreamExt;
use matrix_rtc_call::{
    CallEnd, CallJoinOptions, CallKind, CallStatus, JoinOptions, JoinTransport, RtcCall, RtcClient,
    RtcError, RtcRoom,
};
use matrix_rtc_call_sdk::{
    CallEngine, CallEvent, LiveKitAttachOptions, LiveKitAttachment, MediaAttachment, Participant,
    SdkMatrixBackend, StabilityConfig, attach_livekit,
};
use matrix_rtc_core::{
    BackendError, CommandError, EventIn, LeaveError, LiveKitTokenRequest, MatrixBackend,
    OpenIdToken, RoomOptions, RoomSink, RoomSubjects, Subscription, ToDeviceDelivery,
    ToDeviceRecipient, ToDeviceSink,
};
use matrix_rtc_livekit::{LiveKitTransportConnection, MediaKeyBridge};
use matrix_rtc_transport::{
    AudioFrame, LocalTrackHandle, MediaStreamKind, PublishOptions, RemoteTrackHandle,
    TransportConnection as _,
};
use matrix_sdk::ruma::{OwnedUserId, RoomId};
use matrix_sdk::{Client, Room, RoomState};
use serde::Deserialize;
use serde_json::Value;
use tokio::sync::{broadcast, mpsc, watch};
use tokio::task::JoinHandle;
use tracing::{info, warn};

use crate::audio::{Cut, Cutter, SAMPLE_RATE, VAD_RATE, VadConfig, read_wav, write_wav};
use crate::ipc::{Event, Outbox};

const RTC_MEMBER_TYPES: [&str; 2] = ["m.rtc.member", "org.matrix.msc4143.rtc.member"];
const ROOM_CALL_SLOT_ID: &str = "m.call#room";
const CALL_APPLICATION: &str = "m.call";
/// Playback is pushed in 10 ms frames, paced by a timer, so the listeners are deaf for as long as it is actually heard
/// instead of until the source has queued it.
const PLAY_FRAME: usize = (SAMPLE_RATE / 100) as usize;
/// How long after the bot's last sound the listeners stay deaf: its voice comes back through their microphones after
/// the round trip through the SFU and their jitter buffers.
const ECHO_TAIL_MS: u64 = 500;

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[derive(Debug)]
enum Control {
    Speak { id: String, path: String },
    Leave,
}

#[derive(Debug, Default, PartialEq, Eq)]
enum Phase<C = ()> {
    #[default]
    Idle,
    Joining,
    InCall(C),
    /// `rejoin` is set only when a newer membership arrives while leaving, so a spontaneous SFU
    /// disconnect before `/sync` catches up does not immediately rejoin an empty call.
    Leaving {
        rejoin: bool,
    },
}

#[derive(Debug, PartialEq, Eq)]
enum Transition<C = ()> {
    None,
    StartJoin,
    SendLeave(C),
}

#[derive(Debug)]
struct CallMachine<C = ()> {
    phase: Phase<C>,
    members: HashSet<String>,
}

impl<C> Default for CallMachine<C> {
    fn default() -> Self {
        Self {
            phase: Phase::Idle,
            members: HashSet::new(),
        }
    }
}

impl<C> CallMachine<C> {
    fn set_membership(&mut self, members: HashSet<String>) -> Transition<C> {
        let has_new = !members.is_subset(&self.members);
        let has_any = !members.is_empty();
        self.members = members;
        match (&mut self.phase, has_any, has_new) {
            (Phase::Idle, _, true) => {
                self.phase = Phase::Joining;
                Transition::StartJoin
            }
            (Phase::InCall(_), false, _) => {
                let Phase::InCall(control) =
                    std::mem::replace(&mut self.phase, Phase::Leaving { rejoin: false })
                else {
                    unreachable!()
                };
                Transition::SendLeave(control)
            }
            (Phase::Leaving { rejoin }, false, _) => {
                *rejoin = false;
                Transition::None
            }
            (Phase::Leaving { rejoin }, _, true) => {
                *rejoin = true;
                Transition::None
            }
            _ => Transition::None,
        }
    }

    fn on_joined(&mut self, control: C) -> bool {
        debug_assert!(matches!(self.phase, Phase::Joining));
        if !self.members.is_empty() {
            self.phase = Phase::InCall(control);
            true
        } else {
            self.phase = Phase::Leaving { rejoin: false };
            false
        }
    }

    fn on_leaving(&mut self) {
        if matches!(self.phase, Phase::InCall(_)) {
            self.phase = Phase::Leaving { rejoin: false };
        }
    }

    fn on_left(&mut self, normal: bool) -> Transition<C> {
        if normal && matches!(self.phase, Phase::Leaving { rejoin: true }) {
            self.phase = Phase::Joining;
            Transition::StartJoin
        } else {
            self.phase = Phase::Idle;
            Transition::None
        }
    }

    fn control(&self) -> Option<&C> {
        match &self.phase {
            Phase::InCall(control) => Some(control),
            _ => None,
        }
    }

    fn is_idle_unwanted(&self) -> bool {
        matches!(self.phase, Phase::Idle) && self.members.is_empty()
    }
}

#[derive(Clone)]
pub struct Calls {
    rooms: Arc<Mutex<HashMap<String, CallMachine<mpsc::UnboundedSender<Control>>>>>,
    out: Outbox,
    allowed: Arc<Vec<OwnedUserId>>,
    dir: Arc<PathBuf>,
    vad: VadConfig,
}

impl Calls {
    pub fn new(out: Outbox, allowed: Arc<Vec<OwnedUserId>>, dir: PathBuf, vad: VadConfig) -> Self {
        Self {
            rooms: Arc::default(),
            out,
            allowed,
            dir: Arc::new(dir),
            vad,
        }
    }

    pub fn watch(&self, client: &Client) {
        let client = client.clone();
        let calls = self.clone();
        tokio::spawn(async move {
            let mut updates = client.room_info_notable_update_receiver();
            let mut watchers: HashMap<String, AbortOnDrop> = HashMap::new();
            sync_all_watchers(&client, &calls, &mut watchers);
            loop {
                match updates.recv().await {
                    Ok(update) => {
                        sync_room_watcher(&client, &calls, &mut watchers, &update.room_id)
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => {
                        sync_all_watchers(&client, &calls, &mut watchers)
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
        });
    }

    fn emit(&self, event: Event) {
        let _ = self.out.send(event);
    }

    pub fn set_membership(&self, room: Room, members: HashSet<String>) {
        let room_id = room.room_id().to_string();
        let transition = {
            let mut rooms = self.rooms.lock().unwrap();
            let machine = rooms.entry(room_id.clone()).or_default();
            let transition = machine.set_membership(members);
            if machine.is_idle_unwanted() {
                rooms.remove(&room_id);
            }
            transition
        };
        match transition {
            Transition::StartJoin => self.spawn_join(room),
            Transition::SendLeave(tx) => {
                let _ = tx.send(Control::Leave);
            }
            Transition::None => {}
        }
    }

    fn leave_room(&self, room_id: &str) {
        let transition = {
            let mut rooms = self.rooms.lock().unwrap();
            let Some(machine) = rooms.get_mut(room_id) else {
                return;
            };
            let transition = machine.set_membership(HashSet::new());
            if machine.is_idle_unwanted() {
                rooms.remove(room_id);
            }
            transition
        };
        if let Transition::SendLeave(tx) = transition {
            let _ = tx.send(Control::Leave);
        }
    }

    pub fn speak(&self, room_id: &str, id: String, path: String) -> Result<()> {
        let rooms = self.rooms.lock().unwrap();
        let tx = rooms
            .get(room_id)
            .and_then(CallMachine::control)
            .with_context(|| format!("not in a call in {room_id}"))?;
        tx.send(Control::Speak { id, path })
            .ok()
            .context("the call is ending")
    }

    fn spawn_join(&self, room: Room) {
        let calls = self.clone();
        tokio::spawn(async move {
            let room_id = room.room_id().to_string();
            loop {
                let (normal, reason) = match calls.run_once(&room, &room_id).await {
                    Ok(()) => (true, String::new()),
                    Err(error) => (false, format!("{error:#}")),
                };
                if reason.is_empty() {
                    info!("left the call in {room_id}");
                } else {
                    warn!("left the call in {room_id}: {reason}");
                }
                calls.emit(Event::CallLeft {
                    room_id: room_id.clone(),
                    reason,
                });
                let next = {
                    let mut rooms = calls.rooms.lock().unwrap();
                    let machine = rooms.entry(room_id.clone()).or_default();
                    let transition = machine.on_left(normal);
                    if machine.is_idle_unwanted() {
                        rooms.remove(&room_id);
                    }
                    transition
                };
                if !matches!(next, Transition::StartJoin) {
                    break;
                }
            }
        });
    }

    async fn run_once(&self, room: &Room, room_id: &str) -> Result<()> {
        tokio::fs::create_dir_all(&*self.dir)
            .await
            .with_context(|| format!("creating {}", self.dir.display()))?;
        let call = JoinedCall::join(room).await.context("joining the call")?;
        info!("joined the call in {room_id} as {}", call.local_identity());

        let (tx, rx) = mpsc::unbounded_channel();
        let entered = {
            let mut rooms = self.rooms.lock().unwrap();
            rooms.entry(room_id.to_owned()).or_default().on_joined(tx)
        };

        let result = if entered {
            let result = self.in_call(&call, room_id, rx).await;
            if let Some(machine) = self.rooms.lock().unwrap().get_mut(room_id) {
                machine.on_leaving();
            }
            result
        } else {
            Ok(())
        };
        let left = call.leave().await.context("leaving the call");
        result.and(left)
    }

    async fn in_call(
        &self,
        call: &JoinedCall,
        room_id: &str,
        mut controls: mpsc::UnboundedReceiver<Control>,
    ) -> Result<()> {
        let mic = call
            .publish(PublishOptions::microphone())
            .await
            .context("publishing the bot's audio")?;
        let player = Player::start(mic, room_id.to_owned(), self.out.clone());

        let mut events = call.subscribe_call_events();
        let mut status = call.subscribe_status();
        let mut listeners: HashMap<String, AbortOnDrop> = HashMap::new();
        self.listen_to_all(call, room_id, &player, &mut listeners);
        loop {
            tokio::select! {
                control = controls.recv() => match control {
                    Some(Control::Speak { id, path }) => match std::fs::read(&path).map_err(anyhow::Error::from).and_then(|bytes| read_wav(&bytes)) {
                        Ok((samples, rate)) if rate == SAMPLE_RATE => player.enqueue(id, samples),
                        Ok((_, rate)) => player.refuse(id, &format!("{path} is {rate} Hz, not {SAMPLE_RATE}")),
                        Err(error) => player.refuse(id, &format!("{path}: {error:#}")),
                    },
                    Some(Control::Leave) | None => return Ok(()),
                },
                event = events.recv() => match event {
                    Ok(CallEvent::StreamStarted { member_id, kind: MediaStreamKind::Microphone }) => {
                        self.listen(call, room_id, &member_id, &player, &mut listeners);
                    }
                    Ok(CallEvent::StreamStopped { member_id, kind: MediaStreamKind::Microphone }) => {
                        listeners.remove(&member_id);
                    }
                    Ok(CallEvent::ParticipantLeft { member_id, .. }) => {
                        listeners.remove(&member_id);
                        if !call.participants().iter().any(|p| !p.is_local) {
                            return Ok(());
                        }
                    }
                    Ok(_) => {}
                    Err(broadcast::error::RecvError::Lagged(_)) => self.listen_to_all(call, room_id, &player, &mut listeners),
                    Err(broadcast::error::RecvError::Closed) => anyhow::bail!("the call's events stopped"),
                },
                changed = status.changed() => {
                    changed.context("the call's status stopped")?;
                    if let CallStatus::Ended { reason } = &*status.borrow() {
                        return match reason {
                            CallEnd::Left => Ok(()),
                            reason => Err(anyhow::anyhow!("the call ended: {reason:?}")),
                        };
                    }
                }
            }
        }
    }

    fn listen_to_all(
        &self,
        call: &JoinedCall,
        room_id: &str,
        player: &Player,
        listeners: &mut HashMap<String, AbortOnDrop>,
    ) {
        for participant in call.participants() {
            if !participant.is_local && !listeners.contains_key(&participant.member_id) {
                self.listen(call, room_id, &participant.member_id, player, listeners);
            }
        }
    }

    fn listen(
        &self,
        call: &JoinedCall,
        room_id: &str,
        member_id: &str,
        player: &Player,
        listeners: &mut HashMap<String, AbortOnDrop>,
    ) {
        let Some(participant) = call
            .participants()
            .into_iter()
            .find(|p| p.member_id == member_id)
        else {
            return;
        };
        if !self
            .allowed
            .iter()
            .any(|user| user.as_str() == participant.user_id)
        {
            return;
        }
        let Some(frames) = call
            .remote_track(member_id, MediaStreamKind::Microphone)
            .and_then(|track: Arc<dyn RemoteTrackHandle>| track.audio_frames())
        else {
            return;
        };
        info!("listening to {} in {room_id}", participant.user_id);
        let vad = self.vad;
        let mut detector = earshot::Detector::default();
        let mut segmenter = Utterances {
            room_id: room_id.to_owned(),
            cutter: Cutter::new(
                vad,
                Box::new(move |frame: &[i16]| detector.predict_i16(frame) >= vad.threshold),
            ),
            player: player.clone(),
            out: self.out.clone(),
            dir: self.dir.clone(),
        };
        let task = tokio::spawn(async move {
            let mut frames = frames;
            while let Some(frame) = frames.next().await {
                segmenter.push(&first_channel(frame));
            }
        });
        listeners.insert(member_id.to_owned(), AbortOnDrop(task));
    }
}

fn first_channel(frame: AudioFrame) -> Vec<i16> {
    let channels = frame.num_channels.max(1) as usize;
    if channels == 1 {
        frame.data
    } else {
        frame.data.iter().step_by(channels).copied().collect()
    }
}

struct AbortOnDrop(JoinHandle<()>);

impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        self.0.abort();
    }
}

static UTTERANCES: AtomicU64 = AtomicU64::new(0);

/// The VAD needs well under a millisecond per frame, so it runs inline.
struct Utterances {
    room_id: String,
    cutter: Cutter<Box<dyn FnMut(&[i16]) -> bool + Send>>,
    player: Player,
    out: Outbox,
    dir: Arc<PathBuf>,
}

impl Utterances {
    fn push(&mut self, samples: &[i16]) {
        for cut in self.cutter.push(samples, self.player.audible()) {
            match cut {
                Cut::SpeechStarted => {
                    let _ = self.out.send(Event::CallSpeech {
                        room_id: self.room_id.clone(),
                    });
                }
                Cut::Utterance(samples) => self.pass_on(&samples),
            }
        }
    }

    fn pass_on(&self, samples: &[i16]) {
        let duration_ms = samples.len() as u64 * 1000 / u64::from(VAD_RATE);
        let now = now_ms();
        let path = self.dir.join(format!(
            "call-{now}-{}.wav",
            UTTERANCES.fetch_add(1, Ordering::Relaxed)
        ));
        if let Err(error) = write_wav(&path, samples, VAD_RATE) {
            warn!("writing an utterance failed: {error:#}");
            return;
        }
        let _ = self.out.send(Event::CallUtterance {
            room_id: self.room_id.clone(),
            path: path.to_string_lossy().into_owned(),
            started_at: now.saturating_sub(duration_ms),
        });
    }
}

#[derive(Clone)]
struct Player {
    queue: Arc<Mutex<VecDeque<Clip>>>,
    audible_until: Arc<AtomicU64>,
    room_id: Arc<str>,
    out: Outbox,
    _task: Arc<AbortOnDrop>,
}

struct Clip {
    id: String,
    samples: Vec<i16>,
    position: usize,
}

impl Player {
    fn start(mic: Arc<dyn LocalTrackHandle>, room_id: String, out: Outbox) -> Self {
        let queue: Arc<Mutex<VecDeque<Clip>>> = Arc::default();
        let audible_until: Arc<AtomicU64> = Arc::default();
        let room_id: Arc<str> = room_id.into();
        let (q, a, r, o) = (
            queue.clone(),
            audible_until.clone(),
            room_id.clone(),
            out.clone(),
        );
        let task = tokio::spawn(async move {
            let mut tick = tokio::time::interval(Duration::from_millis(10));
            loop {
                tick.tick().await;
                let data = {
                    let mut queue = q.lock().unwrap();
                    let mut data = Vec::with_capacity(PLAY_FRAME);
                    while data.len() < PLAY_FRAME {
                        let Some(clip) = queue.front_mut() else { break };
                        let take =
                            (PLAY_FRAME - data.len()).min(clip.samples.len() - clip.position);
                        data.extend_from_slice(&clip.samples[clip.position..clip.position + take]);
                        clip.position += take;
                        if clip.position >= clip.samples.len() {
                            let clip = queue.pop_front().expect("the front clip");
                            let _ = o.send(spoken(&r, clip.id));
                        }
                    }
                    if !data.is_empty() {
                        a.store(now_ms() + ECHO_TAIL_MS, Ordering::Relaxed);
                    }
                    data.resize(PLAY_FRAME, 0);
                    data
                };
                let frame = AudioFrame {
                    data,
                    sample_rate: SAMPLE_RATE,
                    num_channels: 1,
                    samples_per_channel: PLAY_FRAME as u32,
                };
                if let Err(error) = mic.capture_audio(frame).await {
                    warn!("playing into the call failed: {error}");
                    break;
                }
            }
        });
        Self {
            queue,
            audible_until,
            room_id,
            out,
            _task: Arc::new(AbortOnDrop(task)),
        }
    }

    /// Deaf from now, not from the next tick: the tick keeps it so while the clip plays.
    fn enqueue(&self, id: String, samples: Vec<i16>) {
        self.audible_until
            .store(now_ms() + ECHO_TAIL_MS, Ordering::Relaxed);
        self.queue.lock().unwrap().push_back(Clip {
            id,
            samples,
            position: 0,
        });
    }

    fn refuse(&self, id: String, why: &str) {
        warn!("cannot play {id}: {why}");
        let _ = self.out.send(spoken(&self.room_id, id));
    }

    fn audible(&self) -> bool {
        now_ms() < self.audible_until.load(Ordering::Relaxed)
    }
}

fn spoken(room_id: &str, id: String) -> Event {
    Event::CallSpoken {
        room_id: room_id.to_owned(),
        id,
    }
}

fn sync_all_watchers(client: &Client, calls: &Calls, watchers: &mut HashMap<String, AbortOnDrop>) {
    let joined = client.joined_rooms();
    let joined_ids: HashSet<String> = joined
        .iter()
        .map(|room| room.room_id().to_string())
        .collect();
    let removed: Vec<String> = watchers
        .keys()
        .filter(|id| !joined_ids.contains(*id))
        .cloned()
        .collect();
    for id in removed {
        watchers.remove(&id);
        calls.leave_room(&id);
    }
    for room in joined {
        let id = room.room_id().to_string();
        watchers
            .entry(id)
            .or_insert_with(|| spawn_room_watcher(client.clone(), room, calls.clone()));
    }
}

fn sync_room_watcher(
    client: &Client,
    calls: &Calls,
    watchers: &mut HashMap<String, AbortOnDrop>,
    room_id: &RoomId,
) {
    let id = room_id.to_string();
    match client.get_room(room_id) {
        Some(room) if room.state() == RoomState::Joined => {
            watchers
                .entry(id)
                .or_insert_with(|| spawn_room_watcher(client.clone(), room, calls.clone()));
        }
        _ => {
            if watchers.remove(&id).is_some() {
                calls.leave_room(&id);
            }
        }
    }
}

fn spawn_room_watcher(client: Client, room: Room, calls: Calls) -> AbortOnDrop {
    AbortOnDrop(tokio::spawn(async move {
        let mut updates = room.sticky_events().subscribe();
        loop {
            if room.state() != RoomState::Joined {
                calls.leave_room(room.room_id().as_str());
                break;
            }
            calls.set_membership(room.clone(), live_members(&client, &room, &calls.allowed));
            match updates.recv().await {
                Ok(_) | Err(broadcast::error::RecvError::Lagged(_)) => {}
                Err(broadcast::error::RecvError::Closed) => break,
            }
        }
    }))
}

#[derive(Deserialize)]
struct RtcMemberContent {
    slot_id: Option<String>,
    application: Option<RtcApplication>,
    member: Option<RtcMember>,
    leave_reason: Option<serde::de::IgnoredAny>,
}

#[derive(Deserialize)]
struct RtcApplication {
    #[serde(rename = "type")]
    kind: Option<String>,
}

#[derive(Deserialize)]
struct RtcMember {
    id: Option<String>,
    membership: Option<String>,
}

impl RtcMemberContent {
    fn live_member_id(&self) -> Option<&str> {
        if self.leave_reason.is_some() || self.slot_id.as_deref() != Some(ROOM_CALL_SLOT_ID) {
            return None;
        }
        if self
            .application
            .as_ref()
            .and_then(|app| app.kind.as_deref())
            != Some(CALL_APPLICATION)
        {
            return None;
        }
        let member = self.member.as_ref()?;
        if member.membership.as_deref() != Some("join") {
            return None;
        }
        member.id.as_deref().filter(|id| !id.is_empty())
    }
}

fn live_members(client: &Client, room: &Room, allowed: &[OwnedUserId]) -> HashSet<String> {
    let own = client.user_id().map(|user| user.as_str());
    let mut members = HashSet::new();
    for entry in room.sticky_events().live() {
        if entry.encryption_info().is_none() {
            continue;
        }
        let event_type = entry.key.event_type.to_string();
        if !RTC_MEMBER_TYPES.contains(&event_type.as_str()) {
            continue;
        }
        let sender = entry.key.sender.as_str();
        if Some(sender) == own || !allowed.iter().any(|user| user.as_str() == sender) {
            continue;
        }
        let Ok(Some(content)) = entry.raw().get_field::<RtcMemberContent>("content") else {
            continue;
        };
        let Some(member_id) = content.live_member_id() else {
            continue;
        };
        members.insert(format!("{sender}\0{member_id}"));
    }
    members
}

// matrix-rust-rtc v0.5.0 translates outbound MSC4143/MSC4354 identifiers to unstable spellings,
// which peers on stable MSC4143 (such as Sable) reject.
#[derive(Clone)]
struct StableWireBackend<B> {
    inner: B,
}

impl<B> StableWireBackend<B> {
    fn new(inner: B) -> Self {
        Self { inner }
    }
}

fn stable_event_type(event_type: String) -> String {
    match event_type.as_str() {
        "org.matrix.msc4143.rtc.member" => "m.rtc.member".to_owned(),
        "org.matrix.msc4143.rtc.slot" => "m.rtc.slot".to_owned(),
        "io.element.call.encryption_keys" => "m.rtc.encryption_key".to_owned(),
        _ => event_type,
    }
}

fn with_stable_sticky_key(mut content: Value) -> Value {
    if let Some(object) = content.as_object_mut()
        && !object.contains_key("sticky_key")
        && let Some(key) = object.remove("msc4354_sticky_key")
    {
        object.insert("sticky_key".to_owned(), key);
    }
    content
}

#[async_trait]
impl<B: MatrixBackend + 'static> MatrixBackend for StableWireBackend<B> {
    fn own_user_id(&self) -> String {
        self.inner.own_user_id()
    }

    fn own_device_id(&self) -> String {
        self.inner.own_device_id()
    }

    async fn send_sticky_event(
        &self,
        room_id: String,
        event_type: String,
        content: Value,
        duration_ms: u64,
    ) -> Result<String, CommandError> {
        self.inner
            .send_sticky_event(
                room_id,
                stable_event_type(event_type),
                with_stable_sticky_key(content),
                duration_ms,
            )
            .await
    }

    async fn send_delayed_state_event(
        &self,
        room_id: String,
        event_type: String,
        state_key: String,
        content: Value,
        delay_ms: u64,
    ) -> Result<String, CommandError> {
        self.inner
            .send_delayed_state_event(room_id, event_type, state_key, content, delay_ms)
            .await
    }

    async fn send_delayed_sticky_event(
        &self,
        room_id: String,
        event_type: String,
        content: Value,
        sticky_duration_ms: u64,
        delay_ms: u64,
    ) -> Result<String, CommandError> {
        self.inner
            .send_delayed_sticky_event(
                room_id,
                stable_event_type(event_type),
                with_stable_sticky_key(content),
                sticky_duration_ms,
                delay_ms,
            )
            .await
    }

    async fn restart_delayed_event(
        &self,
        room_id: String,
        delay_id: String,
    ) -> Result<(), CommandError> {
        self.inner.restart_delayed_event(room_id, delay_id).await
    }

    async fn cancel_delayed_event(
        &self,
        room_id: String,
        delay_id: String,
    ) -> Result<(), CommandError> {
        self.inner.cancel_delayed_event(room_id, delay_id).await
    }

    async fn send_to_device_message(
        &self,
        recipients: Vec<ToDeviceRecipient>,
        message_type: String,
        content: Value,
    ) -> Result<Vec<ToDeviceDelivery>, CommandError> {
        self.inner
            .send_to_device_message(recipients, stable_event_type(message_type), content)
            .await
    }

    async fn send_state_event(
        &self,
        room_id: String,
        event_type: String,
        state_key: String,
        content: Value,
    ) -> Result<String, CommandError> {
        self.inner
            .send_state_event(room_id, stable_event_type(event_type), state_key, content)
            .await
    }

    async fn send_room_event(
        &self,
        room_id: String,
        event_type: String,
        content: Value,
    ) -> Result<String, CommandError> {
        self.inner
            .send_room_event(room_id, event_type, content)
            .await
    }

    async fn redact_event(
        &self,
        room_id: String,
        event_id: String,
        reason: Option<String>,
    ) -> Result<(), CommandError> {
        self.inner.redact_event(room_id, event_id, reason).await
    }

    async fn subscribe_room(
        &self,
        room_id: String,
        subjects: RoomSubjects,
        sink: Arc<dyn RoomSink>,
    ) -> Result<Arc<dyn Subscription>, BackendError> {
        self.inner.subscribe_room(room_id, subjects, sink).await
    }

    async fn subscribe_to_device(
        &self,
        event_types: Vec<String>,
        sink: Arc<dyn ToDeviceSink>,
    ) -> Result<Arc<dyn Subscription>, BackendError> {
        self.inner.subscribe_to_device(event_types, sink).await
    }

    async fn relations(
        &self,
        room_id: String,
        event_id: String,
        rel_type: String,
        event_type: String,
    ) -> Result<Vec<EventIn>, BackendError> {
        self.inner
            .relations(room_id, event_id, rel_type, event_type)
            .await
    }

    async fn openid_token(&self) -> Result<OpenIdToken, BackendError> {
        self.inner.openid_token().await
    }

    async fn livekit_token(&self, request: &LiveKitTokenRequest) -> Result<String, BackendError> {
        self.inner.livekit_token(request).await
    }

    async fn rtc_transports(&self) -> Result<Value, BackendError> {
        self.inner.rtc_transports().await
    }
}

struct JoinedCall {
    call: Arc<RtcCall<StableWireBackend<SdkMatrixBackend>>>,
    _room: RtcRoom<StableWireBackend<SdkMatrixBackend>>,
    engine: CallEngine,
    connection: LiveKitTransportConnection,
    _bridge: Arc<MediaKeyBridge>,
    own_identity: String,
}

impl JoinedCall {
    async fn join(room: &Room) -> Result<Self> {
        let client = room.client();
        anyhow::ensure!(
            client.user_id().is_some(),
            "client has no user id (not logged in)"
        );
        anyhow::ensure!(
            client.device_id().is_some(),
            "client has no device id (not logged in)"
        );
        let room_id = room.room_id().to_string();

        let rtc_client = RtcClient::new(Arc::new(StableWireBackend::new(SdkMatrixBackend::new(
            client,
        ))));
        let rtc_room = rtc_client.room(room_id, RoomOptions::default()).await?;
        rtc_room.seeded().await;

        let mut join = JoinOptions {
            slot_id: ROOM_CALL_SLOT_ID.to_owned(),
            ..JoinOptions::application(CALL_APPLICATION)
        };
        join.transport = JoinTransport::Advertised;
        let call = Arc::new(
            rtc_room
                .join_call(CallJoinOptions {
                    join,
                    kind: CallKind::default(),
                    reactions: None,
                    intent: None,
                })
                .await?,
        );

        let attached = attach_livekit(
            &call,
            rtc_room.backend().clone(),
            LiveKitAttachOptions {
                http: None,
                auto_subscribe: true,
                stability: StabilityConfig::default(),
                own_reconnect_budget: None,
                sfu_fallback: false,
            },
        )
        .await;
        let (engine, connection, own_identity, bridge) = match attached {
            Ok(LiveKitAttachment {
                media:
                    MediaAttachment {
                        engine,
                        own_connection: Some(connection),
                        own_identity,
                        ..
                    },
                key_bridge,
            }) => (engine, connection, own_identity, key_bridge),
            Ok(_) => {
                let _ = call.leave(Default::default()).await;
                anyhow::bail!("the joined call publishes on no LiveKit focus");
            }
            Err(error) => {
                let _ = call.leave(Default::default()).await;
                return Err(error.into());
            }
        };

        let mut status = call.subscribe_status();
        tokio::select! {
            _ = connection.wait_connected() => {}
            _ = status.wait_for(|status| matches!(status, CallStatus::Ended { .. })) => {
                anyhow::bail!("our own focus was given up: {:?}", call.status());
            }
        }

        Ok(Self {
            call,
            _room: rtc_room,
            engine,
            connection,
            _bridge: bridge,
            own_identity,
        })
    }

    fn local_identity(&self) -> &str {
        &self.own_identity
    }

    fn subscribe_call_events(&self) -> broadcast::Receiver<CallEvent> {
        self.engine.subscribe_events()
    }

    fn subscribe_status(&self) -> watch::Receiver<CallStatus> {
        self.call.subscribe_status()
    }

    fn participants(&self) -> Vec<Participant> {
        self.engine.participants()
    }

    fn remote_track(
        &self,
        member_id: &str,
        kind: MediaStreamKind,
    ) -> Option<Arc<dyn RemoteTrackHandle>> {
        self.engine.remote_track(member_id, kind)
    }

    async fn publish(&self, options: PublishOptions) -> Result<Arc<dyn LocalTrackHandle>> {
        Ok(self.engine.publish(options).await?)
    }

    async fn leave(self) -> Result<()> {
        let Self {
            call,
            _room,
            engine,
            connection,
            ..
        } = self;
        let leave_result = call.leave(Default::default()).await;
        let auto_left = matches!(
            leave_result,
            Err(RtcError::SessionOver | RtcError::Leave(LeaveError::NotJoined))
        );
        let leave_result = if auto_left {
            Ok(())
        } else {
            leave_result.map_err(anyhow::Error::from)
        };
        drop(_room);
        engine.shutdown().await;
        let close_result = match connection.close().await {
            Err(_) if auto_left => Ok(()),
            result => result.map_err(anyhow::Error::from),
        };
        leave_result.and(close_result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    fn valid_join() -> Value {
        json!({
            "slot_id": "m.call#room",
            "application": { "type": "m.call" },
            "member": { "id": "m1", "membership": "join" },
        })
    }

    fn with(mut base: Value, key: &str, value: Value) -> Value {
        base[key] = value;
        base
    }

    fn live_member_id(value: Value) -> Option<String> {
        serde_json::from_value::<RtcMemberContent>(value)
            .ok()?
            .live_member_id()
            .map(str::to_owned)
    }

    fn members(ids: &[&str]) -> HashSet<String> {
        ids.iter().map(|&id| id.to_owned()).collect()
    }

    #[test]
    fn a_room_call_join_membership_returns_its_member_id() {
        assert_eq!(live_member_id(valid_join()).as_deref(), Some("m1"));
    }

    #[test]
    fn a_left_or_other_slot_membership_is_not_live() {
        let cases = [
            ("empty", json!({})),
            (
                "left",
                with(
                    valid_join(),
                    "member",
                    json!({ "id": "m1", "membership": "leave" }),
                ),
            ),
            (
                "leave_reason",
                with(valid_join(), "leave_reason", json!({ "code": "leave" })),
            ),
            (
                "other slot",
                with(valid_join(), "slot_id", json!("m.call#breakout")),
            ),
            (
                "other application",
                with(
                    valid_join(),
                    "application",
                    json!({ "type": "io.element.spreadsheet" }),
                ),
            ),
            (
                "empty member id",
                with(
                    valid_join(),
                    "member",
                    json!({ "id": "", "membership": "join" }),
                ),
            ),
        ];
        for (name, value) in cases {
            assert_eq!(live_member_id(value), None, "{name} should not be live");
        }
    }

    #[test]
    fn joins_when_wanted_and_leaves_when_everyone_leaves() {
        let mut m = CallMachine::default();
        assert_eq!(m.set_membership(members(&["m1"])), Transition::StartJoin);
        assert_eq!(m.set_membership(members(&["m1"])), Transition::None);
        assert!(m.on_joined(()));
        assert_eq!(m.set_membership(members(&[])), Transition::SendLeave(()));
        assert_eq!(m.set_membership(members(&[])), Transition::None);
        assert_eq!(m.on_left(true), Transition::None);
    }

    #[test]
    fn leaves_immediately_when_everyone_leaves_during_join() {
        let mut m = CallMachine::default();
        assert_eq!(m.set_membership(members(&["m1"])), Transition::StartJoin);
        assert_eq!(m.set_membership(members(&[])), Transition::None);
        assert!(!m.on_joined(()));
        assert_eq!(m.on_left(true), Transition::None);
    }

    #[test]
    fn stays_in_call_when_user_leaves_and_reenters_during_join() {
        let mut m = CallMachine::default();
        assert_eq!(m.set_membership(members(&["m1"])), Transition::StartJoin);
        assert_eq!(m.set_membership(members(&[])), Transition::None);
        assert_eq!(m.set_membership(members(&["m2"])), Transition::None);
        assert!(m.on_joined(()));
    }

    #[test]
    fn rejoins_when_user_reenters_before_leave_finishes() {
        let mut m = CallMachine::default();
        assert_eq!(m.set_membership(members(&["m1"])), Transition::StartJoin);
        assert!(m.on_joined(()));
        assert_eq!(m.set_membership(members(&[])), Transition::SendLeave(()));
        assert_eq!(m.set_membership(members(&["m2"])), Transition::None);
        assert_eq!(m.on_left(true), Transition::StartJoin);
        assert!(m.on_joined(()));
    }

    #[test]
    fn spontaneous_leave_does_not_rejoin_before_sync_catches_up() {
        let mut m = CallMachine::default();
        assert_eq!(m.set_membership(members(&["m1"])), Transition::StartJoin);
        assert!(m.on_joined(()));
        m.on_leaving();
        assert_eq!(m.on_left(true), Transition::None);
        assert_eq!(m.set_membership(members(&["m1"])), Transition::None);
        assert_eq!(m.set_membership(members(&[])), Transition::None);
        assert_eq!(m.set_membership(members(&["m2"])), Transition::StartJoin);
    }

    #[test]
    fn spontaneous_leave_does_not_rejoin_when_membership_only_shrinks() {
        let mut m = CallMachine::default();
        assert_eq!(
            m.set_membership(members(&["m1", "m2"])),
            Transition::StartJoin
        );
        assert!(m.on_joined(()));
        m.on_leaving();
        assert_eq!(m.set_membership(members(&["m1"])), Transition::None);
        assert_eq!(m.on_left(true), Transition::None);
    }

    #[test]
    fn spontaneous_leave_rejoins_when_a_newer_membership_arrives_during_leave() {
        let mut m = CallMachine::default();
        assert_eq!(m.set_membership(members(&["m1"])), Transition::StartJoin);
        assert!(m.on_joined(()));
        m.on_leaving();
        assert_eq!(m.set_membership(members(&["m2", "m3"])), Transition::None);
        assert_eq!(m.set_membership(members(&["m2"])), Transition::None);
        assert_eq!(m.on_left(true), Transition::StartJoin);
        assert!(m.on_joined(()));
    }

    #[test]
    fn abnormal_exit_does_not_rejoin_until_newer_membership_arrives() {
        let mut m = CallMachine::default();
        assert_eq!(
            m.set_membership(members(&["m1", "m2"])),
            Transition::StartJoin
        );
        assert_eq!(m.on_left(false), Transition::None);
        assert_eq!(m.set_membership(members(&["m1", "m2"])), Transition::None);
        assert_eq!(m.set_membership(members(&["m1"])), Transition::None);
        assert_eq!(m.set_membership(members(&[])), Transition::None);
        assert_eq!(m.set_membership(members(&["m3"])), Transition::StartJoin);

        assert!(m.on_joined(()));
        m.on_leaving();
        assert_eq!(m.on_left(false), Transition::None);
        assert_eq!(m.set_membership(members(&["m3"])), Transition::None);
        assert_eq!(m.set_membership(members(&["m4"])), Transition::StartJoin);
    }
}
