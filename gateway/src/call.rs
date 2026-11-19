//! The call is Element Call's, in its room-state membership format (`org.matrix.msc3401.call.member`): matrix-rust-rtc
//! can write no other format Element Call reads, and it is the only one that arrives over the plain `/sync` the gateway
//! runs (the current format needs sticky events over sliding sync).

use std::collections::{HashMap, HashSet, VecDeque};
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
/// Playback is pushed in 10 ms frames, paced by a timer, so stopping it takes effect at once instead of after the
/// second of audio the source would otherwise queue.
const PLAY_FRAME: usize = (SAMPLE_RATE / 100) as usize;

pub fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

#[derive(Debug)]
pub enum Control {
    Speak { id: String, path: String },
    Leave,
}

#[derive(Clone)]
pub struct Calls {
    rooms: Arc<Mutex<HashMap<String, mpsc::UnboundedSender<Control>>>>,
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

    pub fn join(&self, room: Room, vad: VadConfig) {
        let room_id = room.room_id().to_string();
        let (tx, rx) = mpsc::unbounded_channel();
        {
            let mut rooms = self.rooms.lock().unwrap();
            if rooms.contains_key(&room_id) {
                return;
            }
            rooms.insert(room_id.clone(), tx);
        }
        let calls = self.clone();
        tokio::spawn(async move {
            let reason = match calls.run(&room, vad, rx).await {
                Ok(()) => String::new(),
                Err(error) => format!("{error:#}"),
            };
            calls.rooms.lock().unwrap().remove(&room_id);
            if reason.is_empty() { info!("left the call in {room_id}") } else { warn!("left the call in {room_id}: {reason}") }
            calls.emit(Event::CallLeft { room_id, reason });
        });
    }

    pub fn control(&self, room_id: &str, control: Control) -> Result<()> {
        let rooms = self.rooms.lock().unwrap();
        let tx = rooms.get(room_id).with_context(|| format!("not in a call in {room_id}"))?;
        tx.send(control).ok().context("the call is ending")
    }

    async fn run(&self, room: &Room, vad: VadConfig, controls: mpsc::UnboundedReceiver<Control>) -> Result<()> {
        tokio::fs::create_dir_all(&*self.dir).await.with_context(|| format!("creating {}", self.dir.display()))?;
        let options = LiveKitCallOptions { format: MembershipFormat::RoomState, ..LiveKitCallOptions::default() };
        let call = LiveKitCall::join(room, options).await.context("joining the call")?;
        info!("joined the call in {} as {}", room.room_id(), call.local_identity());
        let result = self.in_call(&call, room.room_id().as_str(), vad, controls).await;
        let left = call.leave().await.context("leaving the call");
        result.and(left)
    }

    async fn in_call(&self, call: &LiveKitCall, room_id: &str, vad: VadConfig, mut controls: mpsc::UnboundedReceiver<Control>) -> Result<()> {
        let mic = call.publish(PublishOptions::microphone()).await.context("publishing the bot's audio")?;
        let player = Player::start(mic, room_id.to_owned(), self.out.clone());
        self.emit(Event::CallJoined { room_id: room_id.to_owned() });

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
        for cut in self.cutter.push(samples) {
            match cut {
                Cut::SpeechStarted => {
                    // Talking over the bot stops it.
                    self.player.hush();
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
        let room_id: Arc<str> = room_id.into();
        let (q, r, o) = (queue.clone(), room_id.clone(), out.clone());
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
                            let _ = o.send(spoken(&r, &clip, false));
                        }
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
        Self { queue, room_id, out, _task: Arc::new(AbortOnDrop(task)) }
    }

    fn enqueue(&self, id: String, samples: Vec<i16>) {
        self.queue.lock().unwrap().push_back(Clip { id, samples, position: 0 });
    }

    fn refuse(&self, id: String, why: &str) {
        warn!("cannot play {id}: {why}");
        let _ = self.out.send(spoken(&self.room_id, &Clip { id, samples: Vec::new(), position: 0 }, true));
    }

    fn hush(&self) {
        let dropped: Vec<Clip> = self.queue.lock().unwrap().drain(..).collect();
        for clip in dropped {
            let _ = self.out.send(spoken(&self.room_id, &clip, true));
        }
    }
}

fn spoken(room_id: &str, clip: &Clip, interrupted: bool) -> Event {
    Event::CallSpoken {
        room_id: room_id.to_owned(),
        id: clip.id.clone(),
        played_ms: clip.position as u64 * 1000 / u64::from(SAMPLE_RATE),
        interrupted,
    }
}

/// Memberships carry a deadline, so the rooms are also looked at again every half minute.
pub fn watch_memberships(client: &Client, out: Outbox, allowed: Arc<Vec<OwnedUserId>>) {
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
        let mut known: HashMap<OwnedRoomId, Vec<String>> = HashMap::new();
        let mut tick = tokio::time::interval(Duration::from_secs(30));
        loop {
            let rooms: Vec<Room> = tokio::select! {
                Some(room_id) = rx.recv() => client.get_room(&room_id).into_iter().collect(),
                _ = tick.tick() => client.joined_rooms(),
            };
            for room in rooms {
                let members = if room.state() == RoomState::Joined { members_in_call(&client, &room, &allowed).await } else { Vec::new() };
                let previous = known.get(room.room_id()).cloned().unwrap_or_default();
                if members != previous {
                    known.insert(room.room_id().to_owned(), members.clone());
                    let _ = out.send(Event::CallMembers { room_id: room.room_id().to_string(), user_ids: members });
                }
            }
        }
    });
}

async fn members_in_call(client: &Client, room: &Room, allowed: &[OwnedUserId]) -> Vec<String> {
    let events = match room.get_state_events(StateEventType::from(MEMBER_EVENT_TYPE)).await {
        Ok(events) => events,
        Err(error) => {
            warn!("reading the call memberships of {} failed: {error}", room.room_id());
            return Vec::new();
        }
    };
    let own = client.user_id().map(|user| user.to_string());
    let now = now_ms();
    let mut members = HashSet::new();
    for event in events {
        let RawAnySyncOrStrippedState::Sync(raw) = event else { continue };
        let Ok(value) = serde_json::from_str::<Value>(raw.json().get()) else { continue };
        let Some(sender) = value.get("sender").and_then(Value::as_str) else { continue };
        if Some(sender) == own.as_deref() || !allowed.iter().any(|user| user.as_str() == sender) {
            continue;
        }
        let ts = value.get("origin_server_ts").and_then(Value::as_u64).unwrap_or(0);
        if value.get("content").is_some_and(|content| is_live_room_call(content, ts, now)) {
            members.insert(sender.to_owned());
        }
    }
    let mut members: Vec<String> = members.into_iter().collect();
    members.sort();
    members
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
}
