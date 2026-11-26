//! The call is Element Call's, in its room-state membership format (`org.matrix.msc3401.call.member`): matrix-rust-rtc
//! can write no other format Element Call reads, and it is the only one that arrives over the plain `/sync` the gateway
//! runs (the current format needs sticky events over sliding sync).

use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use futures_util::StreamExt;
use matrix_rtc_call::{CallEnd, CallStatus};
use matrix_rtc_call_sdk::{CallEvent, LiveKitCall, LiveKitCallOptions};
use matrix_rtc_core::compat::MembershipFormat;
use matrix_rtc_transport::{AudioFrame, LocalTrackHandle, MediaStreamKind, PublishOptions, RemoteTrackHandle};
use matrix_sdk::deserialized_responses::RawAnySyncOrStrippedState;
use matrix_sdk::ruma::events::{AnySyncStateEvent, StateEventType};
use matrix_sdk::ruma::serde::Raw;
use matrix_sdk::ruma::{OwnedRoomId, OwnedUserId};
use matrix_sdk::{Client, Room, RoomState};
use serde_json::Value;
use tokio::sync::{broadcast, mpsc};
use tokio::task::JoinHandle;
use tracing::{info, warn};

use crate::audio::{Cut, Cutter, SAMPLE_RATE, VAD_RATE, VadConfig, read_wav, write_wav};
use crate::ipc::{Event, Outbox};

const MEMBER_EVENT_TYPE: &str = "org.matrix.msc3401.call.member";
/// What Element Call assumes when a membership states no lifetime.
const DEFAULT_EXPIRES_MS: u64 = 4 * 60 * 60 * 1000;
/// Playback is pushed in 10 ms frames, paced by a timer, so the listeners are deaf for as long as it is actually heard
/// instead of until the source has queued it.
const PLAY_FRAME: usize = (SAMPLE_RATE / 100) as usize;
/// How long after the bot's last sound the listeners stay deaf: its voice comes back through their microphones after
/// the round trip through the SFU and their jitter buffers.
const ECHO_TAIL_MS: u64 = 500;

pub fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

#[derive(Debug)]
enum Control {
    Speak { id: String, path: String },
    Leave,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
enum Phase {
    #[default]
    Idle,
    Joining,
    InCall,
    /// `rejoin` is set only when a newer membership arrives while leaving, so a spontaneous SFU
    /// disconnect before `/sync` catches up does not immediately rejoin an empty call.
    Leaving { rejoin: bool },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Transition {
    None,
    StartJoin,
    SendLeave,
}

#[derive(Debug)]
struct CallMachine<M> {
    phase: Phase,
    membership: Option<M>,
}

impl<M> Default for CallMachine<M> {
    fn default() -> Self {
        Self { phase: Phase::Idle, membership: None }
    }
}

impl<M: PartialEq> CallMachine<M> {
    fn set_membership(&mut self, membership: Option<M>) -> Transition {
        if self.membership == membership {
            return Transition::None;
        }
        let wanted = membership.is_some();
        self.membership = membership;
        match (self.phase, wanted) {
            (Phase::Idle, true) => {
                self.phase = Phase::Joining;
                Transition::StartJoin
            }
            (Phase::InCall, false) => {
                self.phase = Phase::Leaving { rejoin: false };
                Transition::SendLeave
            }
            (Phase::Leaving { .. }, wanted) => {
                self.phase = Phase::Leaving { rejoin: wanted };
                Transition::None
            }
            _ => Transition::None,
        }
    }

    fn on_joined(&mut self) -> bool {
        debug_assert_eq!(self.phase, Phase::Joining);
        if self.membership.is_some() {
            self.phase = Phase::InCall;
            true
        } else {
            self.phase = Phase::Leaving { rejoin: false };
            false
        }
    }

    fn on_leaving(&mut self) {
        if self.phase == Phase::InCall {
            self.phase = Phase::Leaving { rejoin: false };
        }
    }

    fn on_left(&mut self, normal: bool) -> Transition {
        if normal && matches!(self.phase, Phase::Leaving { rejoin: true }) {
            self.phase = Phase::Joining;
            Transition::StartJoin
        } else {
            self.phase = Phase::Idle;
            Transition::None
        }
    }

    fn is_idle_unwanted(&self) -> bool {
        self.phase == Phase::Idle && self.membership.is_none()
    }
}

/// Sorted `(user_id, origin_server_ts)` pairs for allowed users live in a room's call, so a quick leave-and-rejoin
/// changes the snapshot even if `/sync` never saw the empty state in between.
type Membership = Vec<(String, u64)>;

#[derive(Default)]
struct RoomEntry {
    machine: CallMachine<Membership>,
    control: Option<mpsc::UnboundedSender<Control>>,
}

#[derive(Clone)]
pub struct Calls {
    rooms: Arc<Mutex<HashMap<String, RoomEntry>>>,
    out: Outbox,
    allowed: Arc<Vec<OwnedUserId>>,
    dir: Arc<PathBuf>,
}

impl Calls {
    pub fn new(out: Outbox, allowed: Arc<Vec<OwnedUserId>>, dir: PathBuf) -> Self {
        Self { rooms: Arc::default(), out, allowed, dir: Arc::new(dir) }
    }

    fn emit(&self, event: Event) {
        let _ = self.out.send(event);
    }

    pub fn set_membership(&self, room: Room, membership: Option<Membership>, vad: VadConfig) {
        let room_id = room.room_id().to_string();
        let action = {
            let mut rooms = self.rooms.lock().unwrap();
            let entry = rooms.entry(room_id.clone()).or_default();
            let transition = entry.machine.set_membership(membership);
            let control = if transition == Transition::SendLeave { entry.control.take() } else { None };
            if entry.machine.is_idle_unwanted() {
                rooms.remove(&room_id);
            }
            (transition, control)
        };
        match action {
            (Transition::StartJoin, _) => self.spawn_join(room, vad),
            (Transition::SendLeave, Some(tx)) => {
                let _ = tx.send(Control::Leave);
            }
            _ => {}
        }
    }

    pub fn speak(&self, room_id: &str, id: String, path: String) -> Result<()> {
        let rooms = self.rooms.lock().unwrap();
        let tx = rooms.get(room_id).and_then(|entry| entry.control.as_ref()).with_context(|| format!("not in a call in {room_id}"))?;
        tx.send(Control::Speak { id, path }).ok().context("the call is ending")
    }

    fn spawn_join(&self, room: Room, vad: VadConfig) {
        let calls = self.clone();
        tokio::spawn(async move {
            let room_id = room.room_id().to_string();
            loop {
                let (normal, reason) = match calls.run_once(&room, &room_id, vad).await {
                    Ok(()) => (true, String::new()),
                    Err(error) => (false, format!("{error:#}")),
                };
                if reason.is_empty() {
                    info!("left the call in {room_id}");
                } else {
                    warn!("left the call in {room_id}: {reason}");
                }
                calls.emit(Event::CallLeft { room_id: room_id.clone(), reason });
                let next = {
                    let mut rooms = calls.rooms.lock().unwrap();
                    let entry = rooms.entry(room_id.clone()).or_default();
                    entry.control = None;
                    let transition = entry.machine.on_left(normal);
                    if entry.machine.is_idle_unwanted() {
                        rooms.remove(&room_id);
                    }
                    transition
                };
                if next != Transition::StartJoin {
                    break;
                }
            }
        });
    }

    async fn run_once(&self, room: &Room, room_id: &str, vad: VadConfig) -> Result<()> {
        tokio::fs::create_dir_all(&*self.dir).await.with_context(|| format!("creating {}", self.dir.display()))?;
        let options = LiveKitCallOptions { format: MembershipFormat::RoomState, ..LiveKitCallOptions::default() };
        let call = LiveKitCall::join(room, options).await.context("joining the call")?;
        info!("joined the call in {room_id} as {}", call.local_identity());

        let rx = {
            let mut rooms = self.rooms.lock().unwrap();
            let entry = rooms.entry(room_id.to_owned()).or_default();
            if entry.machine.on_joined() {
                let (tx, rx) = mpsc::unbounded_channel();
                entry.control = Some(tx);
                Some(rx)
            } else {
                None
            }
        };

        let result = match rx {
            Some(rx) => {
                let result = self.in_call(&call, room_id, vad, rx).await;
                let mut rooms = self.rooms.lock().unwrap();
                if let Some(entry) = rooms.get_mut(room_id) {
                    entry.control = None;
                    entry.machine.on_leaving();
                }
                result
            }
            None => Ok(()),
        };
        let left = call.leave().await.context("leaving the call");
        result.and(left)
    }

    async fn in_call(&self, call: &LiveKitCall, room_id: &str, vad: VadConfig, mut controls: mpsc::UnboundedReceiver<Control>) -> Result<()> {
        let mic = call.publish(PublishOptions::microphone()).await.context("publishing the bot's audio")?;
        let player = Player::start(mic, room_id.to_owned(), self.out.clone());

        let mut events = call.subscribe_call_events();
        let mut status = call.subscribe_status();
        let mut listeners: HashMap<String, AbortOnDrop> = HashMap::new();
        self.listen_to_all(call, room_id, vad, &player, &mut listeners);
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
                        self.listen(call, room_id, &member_id, vad, &player, &mut listeners);
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
                    Err(broadcast::error::RecvError::Lagged(_)) => self.listen_to_all(call, room_id, vad, &player, &mut listeners),
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

    fn listen_to_all(&self, call: &LiveKitCall, room_id: &str, vad: VadConfig, player: &Player, listeners: &mut HashMap<String, AbortOnDrop>) {
        for participant in call.participants() {
            if !participant.is_local && !listeners.contains_key(&participant.member_id) {
                self.listen(call, room_id, &participant.member_id, vad, player, listeners);
            }
        }
    }

    fn listen(&self, call: &LiveKitCall, room_id: &str, member_id: &str, vad: VadConfig, player: &Player, listeners: &mut HashMap<String, AbortOnDrop>) {
        let Some(participant) = call.participants().into_iter().find(|p| p.member_id == member_id) else { return };
        if !self.allowed.iter().any(|user| user.as_str() == participant.user_id) {
            return;
        }
        let Some(frames) = call.remote_track(member_id, MediaStreamKind::Microphone).and_then(|track: Arc<dyn RemoteTrackHandle>| track.audio_frames()) else {
            return;
        };
        info!("listening to {} in {room_id}", participant.user_id);
        let mut detector = earshot::Detector::default();
        let mut segmenter = Utterances {
            room_id: room_id.to_owned(),
            cutter: Cutter::new(vad, Box::new(move |frame: &[i16]| detector.predict_i16(frame) >= vad.threshold)),
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
    if channels == 1 { frame.data } else { frame.data.iter().step_by(channels).copied().collect() }
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
                    let _ = self.out.send(Event::CallSpeech { room_id: self.room_id.clone() });
                }
                Cut::Utterance(samples) => self.pass_on(&samples),
            }
        }
    }

    fn pass_on(&self, samples: &[i16]) {
        let duration_ms = samples.len() as u64 * 1000 / u64::from(VAD_RATE);
        let now = now_ms();
        let path = self.dir.join(format!("call-{now}-{}.wav", UTTERANCES.fetch_add(1, Ordering::Relaxed)));
        if let Err(error) = write_wav(&path, samples, VAD_RATE) {
            warn!("writing an utterance failed: {error:#}");
            return;
        }
        let _ = self.out.send(Event::CallUtterance { room_id: self.room_id.clone(), path: path.to_string_lossy().into_owned(), started_at: now.saturating_sub(duration_ms) });
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
        let (q, a, r, o) = (queue.clone(), audible_until.clone(), room_id.clone(), out.clone());
        let task = tokio::spawn(async move {
            let mut tick = tokio::time::interval(Duration::from_millis(10));
            loop {
                tick.tick().await;
                let data = {
                    let mut queue = q.lock().unwrap();
                    let mut data = Vec::with_capacity(PLAY_FRAME);
                    while data.len() < PLAY_FRAME {
                        let Some(clip) = queue.front_mut() else { break };
                        let take = (PLAY_FRAME - data.len()).min(clip.samples.len() - clip.position);
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
                let frame = AudioFrame { data, sample_rate: SAMPLE_RATE, num_channels: 1, samples_per_channel: PLAY_FRAME as u32 };
                if let Err(error) = mic.capture_audio(frame).await {
                    warn!("playing into the call failed: {error}");
                    break;
                }
            }
        });
        Self { queue, audible_until, room_id, out, _task: Arc::new(AbortOnDrop(task)) }
    }

    /// Deaf from now, not from the next tick: the tick keeps it so while the clip plays.
    fn enqueue(&self, id: String, samples: Vec<i16>) {
        self.audible_until.store(now_ms() + ECHO_TAIL_MS, Ordering::Relaxed);
        self.queue.lock().unwrap().push_back(Clip { id, samples, position: 0 });
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
    Event::CallSpoken { room_id: room_id.to_owned(), id }
}

/// Memberships carry a deadline, so the rooms are also looked at again every half minute.
pub fn watch_memberships(client: &Client, calls: Calls, vad: VadConfig) {
    let (tx, mut rx) = mpsc::unbounded_channel::<OwnedRoomId>();
    client.add_event_handler(move |event: Raw<AnySyncStateEvent>, room: Room| {
        let tx = tx.clone();
        async move {
            if event.get_field::<String>("type").ok().flatten().as_deref() == Some(MEMBER_EVENT_TYPE) {
                let _ = tx.send(room.room_id().to_owned());
            }
        }
    });
    let client = client.clone();
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(30));
        loop {
            let rooms: Vec<Room> = tokio::select! {
                Some(room_id) = rx.recv() => client.get_room(&room_id).into_iter().collect(),
                _ = tick.tick() => client.joined_rooms(),
            };
            for room in rooms {
                if room.state() != RoomState::Joined {
                    calls.set_membership(room, None, vad);
                    continue;
                }
                if let Some(members) = members_in_call(&client, &room, &calls.allowed).await {
                    let membership = if members.is_empty() { None } else { Some(members) };
                    calls.set_membership(room, membership, vad);
                }
            }
        }
    });
}

async fn members_in_call(client: &Client, room: &Room, allowed: &[OwnedUserId]) -> Option<Membership> {
    let events = match room.get_state_events(StateEventType::from(MEMBER_EVENT_TYPE)).await {
        Ok(events) => events,
        Err(error) => {
            warn!("reading the call memberships of {} failed: {error}", room.room_id());
            return None;
        }
    };
    let own = client.user_id().map(|user| user.to_string());
    let now = now_ms();
    let mut members: HashMap<String, u64> = HashMap::new();
    for event in events {
        let RawAnySyncOrStrippedState::Sync(raw) = event else { continue };
        let Ok(value) = serde_json::from_str::<Value>(raw.json().get()) else { continue };
        let Some(sender) = value.get("sender").and_then(Value::as_str) else { continue };
        if Some(sender) == own.as_deref() || !allowed.iter().any(|user| user.as_str() == sender) {
            continue;
        }
        let ts = value.get("origin_server_ts").and_then(Value::as_u64).unwrap_or(0);
        if value.get("content").is_some_and(|content| is_live_room_call(content, ts, now)) {
            members.entry(sender.to_owned()).and_modify(|seen| *seen = (*seen).max(ts)).or_insert(ts);
        }
    }
    let mut members: Membership = members.into_iter().collect();
    members.sort();
    Some(members)
}

/// `{}` is how a member leaves.
fn is_live_room_call(content: &Value, origin_server_ts: u64, now: u64) -> bool {
    let Some(object) = content.as_object() else { return false };
    if object.is_empty() || object.get("application").and_then(Value::as_str) != Some("m.call") {
        return false;
    }
    if !object.get("call_id").and_then(Value::as_str).unwrap_or("").is_empty() {
        return false;
    }
    let joined_at = object.get("created_ts").and_then(Value::as_u64).map_or(origin_server_ts, |created| created.min(origin_server_ts));
    let expires = object.get("expires").and_then(Value::as_u64).unwrap_or(DEFAULT_EXPIRES_MS);
    joined_at.saturating_add(expires) > now
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_membership_is_live_until_its_deadline() {
        let content = json!({ "application": "m.call", "call_id": "", "scope": "m.room", "device_id": "D", "expires": 1000, "created_ts": 5000 });
        assert!(is_live_room_call(&content, 6000, 5999));
        assert!(!is_live_room_call(&content, 6000, 6000));
        // Without `created_ts`, the deadline counts from the event; without `expires`, four hours.
        assert!(is_live_room_call(&json!({ "application": "m.call", "call_id": "" }), 10, 10 + DEFAULT_EXPIRES_MS - 1));
    }

    #[test]
    fn a_left_or_other_membership_is_not() {
        assert!(!is_live_room_call(&json!({}), 0, 0));
        assert!(!is_live_room_call(&json!({ "application": "m.call", "call_id": "breakout" }), 0, 0));
        assert!(!is_live_room_call(&json!({ "application": "io.element.spreadsheet", "call_id": "" }), 0, 0));
    }

    #[test]
    fn joins_when_wanted_and_leaves_when_everyone_leaves() {
        let mut m = CallMachine::<u64>::default();
        assert_eq!(m.set_membership(Some(1)), Transition::StartJoin);
        assert_eq!(m.set_membership(Some(1)), Transition::None);
        assert!(m.on_joined());
        assert_eq!(m.set_membership(None), Transition::SendLeave);
        assert_eq!(m.set_membership(None), Transition::None);
        assert_eq!(m.on_left(true), Transition::None);
    }

    #[test]
    fn leaves_immediately_when_everyone_leaves_during_join() {
        let mut m = CallMachine::<u64>::default();
        assert_eq!(m.set_membership(Some(1)), Transition::StartJoin);
        assert_eq!(m.set_membership(None), Transition::None);
        assert!(!m.on_joined());
        assert_eq!(m.on_left(true), Transition::None);
    }

    #[test]
    fn stays_in_call_when_user_leaves_and_reenters_during_join() {
        let mut m = CallMachine::<u64>::default();
        assert_eq!(m.set_membership(Some(1)), Transition::StartJoin);
        assert_eq!(m.set_membership(None), Transition::None);
        assert_eq!(m.set_membership(Some(2)), Transition::None);
        assert!(m.on_joined());
    }

    #[test]
    fn rejoins_when_user_reenters_before_leave_finishes() {
        let mut m = CallMachine::<u64>::default();
        assert_eq!(m.set_membership(Some(1)), Transition::StartJoin);
        assert!(m.on_joined());
        assert_eq!(m.set_membership(None), Transition::SendLeave);
        assert_eq!(m.set_membership(Some(2)), Transition::None);
        assert_eq!(m.on_left(true), Transition::StartJoin);
        assert!(m.on_joined());
    }

    #[test]
    fn spontaneous_leave_does_not_rejoin_before_sync_catches_up() {
        let mut m = CallMachine::<u64>::default();
        assert_eq!(m.set_membership(Some(1)), Transition::StartJoin);
        assert!(m.on_joined());
        m.on_leaving();
        assert_eq!(m.on_left(true), Transition::None);
        assert_eq!(m.set_membership(Some(1)), Transition::None);
        assert_eq!(m.set_membership(None), Transition::None);
        assert_eq!(m.set_membership(Some(2)), Transition::StartJoin);
    }

    #[test]
    fn spontaneous_leave_rejoins_when_a_newer_membership_arrives_during_leave() {
        let mut m = CallMachine::<u64>::default();
        assert_eq!(m.set_membership(Some(1)), Transition::StartJoin);
        assert!(m.on_joined());
        m.on_leaving();
        assert_eq!(m.set_membership(Some(2)), Transition::None);
        assert_eq!(m.on_left(true), Transition::StartJoin);
        assert!(m.on_joined());
    }

    #[test]
    fn abnormal_exit_does_not_rejoin_until_membership_changes() {
        let mut m = CallMachine::<u64>::default();
        assert_eq!(m.set_membership(Some(1)), Transition::StartJoin);
        assert_eq!(m.on_left(false), Transition::None);
        assert_eq!(m.set_membership(Some(1)), Transition::None);
        assert_eq!(m.set_membership(None), Transition::None);
        assert_eq!(m.set_membership(Some(2)), Transition::StartJoin);

        assert!(m.on_joined());
        m.on_leaving();
        assert_eq!(m.on_left(false), Transition::None);
        assert_eq!(m.set_membership(Some(2)), Transition::None);
        assert_eq!(m.set_membership(Some(3)), Transition::StartJoin);
    }
}
