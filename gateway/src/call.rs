use std::collections::{HashMap, HashSet, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use futures_util::StreamExt;
use matrix_rtc_call::{CallEnd, CallStatus};
use matrix_rtc_call_sdk::{CallEvent, LiveKitCall, LiveKitCallOptions};
use matrix_rtc_transport::{AudioFrame, LocalTrackHandle, MediaStreamKind, PublishOptions, RemoteTrackHandle};
use matrix_sdk::ruma::OwnedUserId;
use matrix_sdk::{Client, Room, RoomState};
use serde_json::Value;
use tokio::sync::{broadcast, mpsc};
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
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
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
    Leaving { rejoin: bool },
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
    latest_ts: Option<u64>,
}

impl<C> Default for CallMachine<C> {
    fn default() -> Self {
        Self { phase: Phase::Idle, latest_ts: None }
    }
}

impl<C> CallMachine<C> {
    fn set_membership(&mut self, latest_ts: Option<u64>) -> Transition<C> {
        let is_newer = latest_ts > self.latest_ts;
        self.latest_ts = latest_ts;
        match (&mut self.phase, latest_ts.is_some(), is_newer) {
            (Phase::Idle, _, true) => {
                self.phase = Phase::Joining;
                Transition::StartJoin
            }
            (Phase::InCall(_), false, _) => {
                let Phase::InCall(control) = std::mem::replace(&mut self.phase, Phase::Leaving { rejoin: false }) else {
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
        if self.latest_ts.is_some() {
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
        matches!(self.phase, Phase::Idle) && self.latest_ts.is_none()
    }
}

#[derive(Clone)]
pub struct Calls {
    rooms: Arc<Mutex<HashMap<String, CallMachine<mpsc::UnboundedSender<Control>>>>>,
    watchers: Arc<Mutex<HashMap<String, AbortOnDrop>>>,
    out: Outbox,
    allowed: Arc<Vec<OwnedUserId>>,
    dir: Arc<PathBuf>,
    vad: VadConfig,
}

impl Calls {
    pub fn new(out: Outbox, allowed: Arc<Vec<OwnedUserId>>, dir: PathBuf, vad: VadConfig) -> Self {
        Self { rooms: Arc::default(), watchers: Arc::default(), out, allowed, dir: Arc::new(dir), vad }
    }

    pub fn sync_rooms(&self, client: &Client, joined: Vec<Room>) {
        let joined_ids: HashSet<String> = joined.iter().map(|room| room.room_id().to_string()).collect();
        let left: Vec<String> = {
            let mut watchers = self.watchers.lock().unwrap();
            let removed: Vec<String> = watchers.keys().filter(|id| !joined_ids.contains(*id)).cloned().collect();
            for id in &removed {
                watchers.remove(id);
            }
            for room in joined {
                let id = room.room_id().to_string();
                watchers.entry(id).or_insert_with(|| spawn_room_watcher(client.clone(), room, self.clone()));
            }
            removed
        };
        for id in left {
            self.leave_room(&id);
        }
    }

    fn emit(&self, event: Event) {
        let _ = self.out.send(event);
    }

    pub fn set_membership(&self, room: Room, latest_ts: Option<u64>) {
        let room_id = room.room_id().to_string();
        let transition = {
            let mut rooms = self.rooms.lock().unwrap();
            let machine = rooms.entry(room_id.clone()).or_default();
            let transition = machine.set_membership(latest_ts);
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
            let Some(machine) = rooms.get_mut(room_id) else { return };
            let transition = machine.set_membership(None);
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
        let tx = rooms.get(room_id).and_then(CallMachine::control).with_context(|| format!("not in a call in {room_id}"))?;
        tx.send(Control::Speak { id, path }).ok().context("the call is ending")
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
                calls.emit(Event::CallLeft { room_id: room_id.clone(), reason });
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
        tokio::fs::create_dir_all(&*self.dir).await.with_context(|| format!("creating {}", self.dir.display()))?;
        let call = LiveKitCall::join(room, LiveKitCallOptions::default()).await.context("joining the call")?;
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

    async fn in_call(&self, call: &LiveKitCall, room_id: &str, mut controls: mpsc::UnboundedReceiver<Control>) -> Result<()> {
        let mic = call.publish(PublishOptions::microphone()).await.context("publishing the bot's audio")?;
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

    fn listen_to_all(&self, call: &LiveKitCall, room_id: &str, player: &Player, listeners: &mut HashMap<String, AbortOnDrop>) {
        for participant in call.participants() {
            if !participant.is_local && !listeners.contains_key(&participant.member_id) {
                self.listen(call, room_id, &participant.member_id, player, listeners);
            }
        }
    }

    fn listen(&self, call: &LiveKitCall, room_id: &str, member_id: &str, player: &Player, listeners: &mut HashMap<String, AbortOnDrop>) {
        let Some(participant) = call.participants().into_iter().find(|p| p.member_id == member_id) else { return };
        if !self.allowed.iter().any(|user| user.as_str() == participant.user_id) {
            return;
        }
        let Some(frames) = call.remote_track(member_id, MediaStreamKind::Microphone).and_then(|track: Arc<dyn RemoteTrackHandle>| track.audio_frames()) else {
            return;
        };
        info!("listening to {} in {room_id}", participant.user_id);
        let vad = self.vad;
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

fn spawn_room_watcher(client: Client, room: Room, calls: Calls) -> AbortOnDrop {
    AbortOnDrop(tokio::spawn(async move {
        let mut updates = room.sticky_events().subscribe();
        loop {
            if room.state() != RoomState::Joined {
                calls.leave_room(room.room_id().as_str());
                break;
            }
            calls.set_membership(room.clone(), latest_member_ts(&client, &room, &calls.allowed));
            match updates.recv().await {
                Ok(_) | Err(broadcast::error::RecvError::Lagged(_)) => {}
                Err(broadcast::error::RecvError::Closed) => break,
            }
        }
    }))
}

fn latest_member_ts(client: &Client, room: &Room, allowed: &[OwnedUserId]) -> Option<u64> {
    let own = client.user_id().map(|user| user.as_str());
    let mut latest: Option<u64> = None;
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
        let Ok(Some(content)) = entry.raw().get_field::<Value>("content") else { continue };
        if !is_live_room_call(&content) {
            continue;
        }
        let ts = entry.raw().get_field::<u64>("origin_server_ts").ok().flatten().unwrap_or(0);
        latest = Some(latest.map_or(ts, |prev| prev.max(ts)));
    }
    latest
}

fn is_live_room_call(content: &Value) -> bool {
    if content.get("leave_reason").is_some() {
        return false;
    }
    if content.get("slot_id").and_then(Value::as_str) != Some(ROOM_CALL_SLOT_ID) {
        return false;
    }
    if content.get("application").and_then(|app| app.get("type")).and_then(Value::as_str) != Some(CALL_APPLICATION) {
        return false;
    }
    let Some(member) = content.get("member") else { return false };
    member.get("membership").and_then(Value::as_str) == Some("join")
        && member.get("id").and_then(Value::as_str).is_some_and(|id| !id.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_room_call_join_membership_is_live() {
        let content = json!({
            "slot_id": "m.call#room",
            "application": { "type": "m.call" },
            "member": { "id": "m1", "membership": "join" },
            "sticky_key": "m1",
        });
        assert!(is_live_room_call(&content));
    }

    #[test]
    fn a_left_or_other_slot_membership_is_not() {
        assert!(!is_live_room_call(&json!({})));
        assert!(!is_live_room_call(&json!({
            "slot_id": "m.call#room",
            "application": { "type": "m.call" },
            "member": { "id": "m1", "membership": "leave" },
        })));
        assert!(!is_live_room_call(&json!({
            "slot_id": "m.call#room",
            "application": { "type": "m.call" },
            "member": { "id": "m1", "membership": "join" },
            "leave_reason": { "code": "leave" },
        })));
        assert!(!is_live_room_call(&json!({
            "slot_id": "m.call#breakout",
            "application": { "type": "m.call" },
            "member": { "id": "m1", "membership": "join" },
        })));
        assert!(!is_live_room_call(&json!({
            "slot_id": "m.call#room",
            "application": { "type": "io.element.spreadsheet" },
            "member": { "id": "m1", "membership": "join" },
        })));
        assert!(!is_live_room_call(&json!({
            "slot_id": "m.call#room",
            "application": { "type": "m.call" },
            "member": { "id": "", "membership": "join" },
        })));
    }

    #[test]
    fn joins_when_wanted_and_leaves_when_everyone_leaves() {
        let mut m = CallMachine::default();
        assert_eq!(m.set_membership(Some(1)), Transition::StartJoin);
        assert_eq!(m.set_membership(Some(1)), Transition::None);
        assert!(m.on_joined(()));
        assert_eq!(m.set_membership(None), Transition::SendLeave(()));
        assert_eq!(m.set_membership(None), Transition::None);
        assert_eq!(m.on_left(true), Transition::None);
    }

    #[test]
    fn leaves_immediately_when_everyone_leaves_during_join() {
        let mut m = CallMachine::default();
        assert_eq!(m.set_membership(Some(1)), Transition::StartJoin);
        assert_eq!(m.set_membership(None), Transition::None);
        assert!(!m.on_joined(()));
        assert_eq!(m.on_left(true), Transition::None);
    }

    #[test]
    fn stays_in_call_when_user_leaves_and_reenters_during_join() {
        let mut m = CallMachine::default();
        assert_eq!(m.set_membership(Some(1)), Transition::StartJoin);
        assert_eq!(m.set_membership(None), Transition::None);
        assert_eq!(m.set_membership(Some(2)), Transition::None);
        assert!(m.on_joined(()));
    }

    #[test]
    fn rejoins_when_user_reenters_before_leave_finishes() {
        let mut m = CallMachine::default();
        assert_eq!(m.set_membership(Some(1)), Transition::StartJoin);
        assert!(m.on_joined(()));
        assert_eq!(m.set_membership(None), Transition::SendLeave(()));
        assert_eq!(m.set_membership(Some(2)), Transition::None);
        assert_eq!(m.on_left(true), Transition::StartJoin);
        assert!(m.on_joined(()));
    }

    #[test]
    fn spontaneous_leave_does_not_rejoin_before_sync_catches_up() {
        let mut m = CallMachine::default();
        assert_eq!(m.set_membership(Some(1)), Transition::StartJoin);
        assert!(m.on_joined(()));
        m.on_leaving();
        assert_eq!(m.on_left(true), Transition::None);
        assert_eq!(m.set_membership(Some(1)), Transition::None);
        assert_eq!(m.set_membership(None), Transition::None);
        assert_eq!(m.set_membership(Some(2)), Transition::StartJoin);
    }

    #[test]
    fn spontaneous_leave_does_not_rejoin_when_membership_only_shrinks() {
        let mut m = CallMachine::default();
        assert_eq!(m.set_membership(Some(2)), Transition::StartJoin);
        assert!(m.on_joined(()));
        m.on_leaving();
        assert_eq!(m.set_membership(Some(1)), Transition::None);
        assert_eq!(m.on_left(true), Transition::None);
    }

    #[test]
    fn spontaneous_leave_rejoins_when_a_newer_membership_arrives_during_leave() {
        let mut m = CallMachine::default();
        assert_eq!(m.set_membership(Some(1)), Transition::StartJoin);
        assert!(m.on_joined(()));
        m.on_leaving();
        assert_eq!(m.set_membership(Some(3)), Transition::None);
        assert_eq!(m.set_membership(Some(2)), Transition::None);
        assert_eq!(m.on_left(true), Transition::StartJoin);
        assert!(m.on_joined(()));
    }

    #[test]
    fn abnormal_exit_does_not_rejoin_until_newer_membership_arrives() {
        let mut m = CallMachine::default();
        assert_eq!(m.set_membership(Some(2)), Transition::StartJoin);
        assert_eq!(m.on_left(false), Transition::None);
        assert_eq!(m.set_membership(Some(2)), Transition::None);
        assert_eq!(m.set_membership(Some(1)), Transition::None);
        assert_eq!(m.set_membership(None), Transition::None);
        assert_eq!(m.set_membership(Some(3)), Transition::StartJoin);

        assert!(m.on_joined(()));
        m.on_leaving();
        assert_eq!(m.on_left(false), Transition::None);
        assert_eq!(m.set_membership(Some(3)), Transition::None);
        assert_eq!(m.set_membership(Some(4)), Transition::StartJoin);
    }
}
