use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use matrix_sdk::attachment::{AttachmentConfig, AttachmentInfo, BaseAudioInfo};
use matrix_sdk::config::SyncSettings;
use matrix_sdk::event_handler::Ctx;
use matrix_sdk::ruma::api::error::ErrorKind;
use matrix_sdk::ruma::events::room::encrypted::OriginalSyncRoomEncryptedEvent;
use matrix_sdk::ruma::events::room::member::StrippedRoomMemberEvent;
use matrix_sdk::ruma::events::room::message::{
    AudioMessageEventContent, MessageType, OriginalSyncRoomMessageEvent, Relation, RoomMessageEventContent,
};
use matrix_sdk::ruma::{OwnedTransactionId, OwnedUserId, RoomId, UInt};
use matrix_sdk::{Client, LoopCtrl, Room, RoomState};
use tokio::io::{AsyncBufReadExt, BufReader, stdin};
use tokio::task::JoinHandle;
use tracing::{info, warn};

use crate::config::Config;
use crate::ipc::{Audio, Command, Event, Message, Outbox, spawn_writer};
use crate::session;
use crate::state::State;

/// What the event handlers and the command loop share.
#[derive(Clone)]
struct Shared {
    out: Outbox,
    state: Arc<Mutex<State>>,
    allowed: Arc<Vec<OwnedUserId>>,
    /// Where received recordings are written for the agent.
    voice_dir: Arc<PathBuf>,
    /// Per room, the task that keeps its typing notice alive.
    typing: Arc<Mutex<HashMap<String, JoinHandle<()>>>>,
}

impl Shared {
    fn emit(&self, event: Event) {
        // Fails only once the writer has stopped, which is when the agent is gone.
        let _ = self.out.send(event);
    }

    fn is_allowed(&self, user: &OwnedUserId) -> bool {
        self.allowed.contains(user)
    }
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

pub async fn run(config: &Config) -> Result<()> {
    let client = session::restore(config).await?;
    let state = State::load(&config.data_dir().join("gateway-state.json"))?;
    let shared = Shared {
        out: spawn_writer(),
        state: Arc::new(Mutex::new(state)),
        allowed: Arc::new(config.matrix.allowed_users.clone()),
        voice_dir: Arc::new(config.data_dir().join("voice").join("in")),
        typing: Arc::default(),
    };

    let user_id = client.user_id().context("the session has no user")?.to_string();
    let device_id = client.device_id().context("the session has no device")?.to_string();
    shared.emit(Event::Ready { user_id, device_id });

    // Messages the agent had not acked when the last process ended.
    for message in shared.state.lock().unwrap().unacked() {
        shared.emit(Event::Message(message));
    }

    client.add_event_handler_context(shared.clone());
    client.add_event_handler(on_message);
    client.add_event_handler(on_undecryptable);
    client.add_event_handler(on_invite);

    let commands = tokio::spawn(read_commands(client.clone(), shared.clone()));
    let sync = client.sync_with_result_callback(SyncSettings::default(), |result| async move {
        match result {
            Ok(_) => Ok(LoopCtrl::Continue),
            // A rejected access token does not get better by retrying.
            Err(error) if matches!(error.client_api_error_kind(), Some(ErrorKind::UnknownToken { .. })) => Err(error),
            Err(error) => {
                warn!("sync failed, retrying: {error}");
                tokio::time::sleep(Duration::from_secs(5)).await;
                Ok(LoopCtrl::Continue)
            }
        }
    });

    let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    tokio::select! {
        result = sync => result.context("sync stopped")?,
        // End of input: the agent closed the pipe or died. Without it there is nobody to pass messages to.
        result = commands => result.context("command loop")??,
        _ = tokio::signal::ctrl_c() => info!("interrupted"),
        _ = terminate.recv() => info!("terminated"),
    }
    Ok(())
}

/// Larger recordings are refused rather than downloaded: several minutes of speech is far below this.
const MAX_AUDIO_BYTES: u64 = 20 * 1024 * 1024;

/// A text or audio message from an allowed user is stored in the inbox, then passed to the agent. An audio message is
/// downloaded and decrypted first, so what the inbox holds is complete without the homeserver.
async fn on_message(event: OriginalSyncRoomMessageEvent, room: Room, client: Client, Ctx(shared): Ctx<Shared>) {
    if room.state() != RoomState::Joined || Some(&*event.sender) == client.user_id() || !shared.is_allowed(&event.sender) {
        return;
    }
    // An edit is not a new request.
    if matches!(event.content.relates_to, Some(Relation::Replacement(_))) {
        return;
    }
    let ts: u64 = event.origin_server_ts.0.into();
    let room_id = room.room_id().to_string();
    let event_id = event.event_id.to_string();
    {
        let state = shared.state.lock().unwrap();
        // Already passed on (a sync can repeat), or history from before the bot joined.
        if state.has(&event_id) || state.predates_join(&room_id, ts) {
            return;
        }
    }
    let (body, audio) = match &event.content.msgtype {
        MessageType::Text(text) => (text.body.clone(), None),
        MessageType::Audio(content) => match download_audio(&client, &shared.voice_dir, &event_id, content).await {
            Ok(audio) => (content.body.clone(), Some(audio)),
            Err(error) => {
                warn!("downloading the audio of {event_id} failed: {error:#}");
                shared.emit(Event::Undecryptable { room_id, event_id, sender: event.sender.to_string() });
                return;
            }
        },
        _ => return,
    };
    let message = Message { room_id, event_id, sender: event.sender.to_string(), body, ts, audio };

    let added = shared.state.lock().unwrap().add(&message);
    match added {
        Ok(true) => shared.emit(Event::Message(message)),
        Ok(false) => {}
        Err(error) => shared.emit(Event::Error { request_id: None, message: format!("storing {} failed: {error:#}", message.event_id) }),
    }
}

/// Writes the recording of an audio message to `<dir>/<event>.<ext>` and returns where.
async fn download_audio(client: &Client, dir: &Path, event_id: &str, content: &AudioMessageEventContent) -> Result<Audio> {
    let info = content.info.as_deref();
    if let Some(size) = info.and_then(|info| info.size) {
        anyhow::ensure!(u64::from(size) <= MAX_AUDIO_BYTES, "the recording is {size} bytes, more than {MAX_AUDIO_BYTES}");
    }
    let data = client.media().get_file(content, false).await?.context("the message has no file")?;
    anyhow::ensure!(data.len() as u64 <= MAX_AUDIO_BYTES, "the recording is {} bytes, more than {MAX_AUDIO_BYTES}", data.len());
    let mimetype = info.and_then(|info| info.mimetype.clone());
    let path = dir.join(format!("{}.{}", file_stem(event_id), extension(mimetype.as_deref())));
    tokio::fs::create_dir_all(dir).await.with_context(|| format!("creating {}", dir.display()))?;
    tokio::fs::write(&path, data).await.with_context(|| format!("writing {}", path.display()))?;
    Ok(Audio { path: path.to_string_lossy().into_owned(), mimetype, voice: content.voice.is_some() })
}

/// An event ID as a file name: anything but letters, digits, `-` and `_` becomes `_`.
fn file_stem(event_id: &str) -> String {
    event_id.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' }).collect()
}

/// Only a hint for whoever looks at the directory; the agent's decoder reads the container itself.
fn extension(mimetype: Option<&str>) -> &'static str {
    match mimetype.map(|m| m.split(';').next().unwrap_or("").trim()) {
        Some("audio/ogg" | "audio/opus") => "ogg",
        Some("audio/mp4" | "audio/m4a" | "audio/x-m4a" | "audio/aac") => "m4a",
        Some("audio/mpeg" | "audio/mp3") => "mp3",
        Some("audio/webm") => "webm",
        Some("audio/wav" | "audio/x-wav") => "wav",
        _ => "audio",
    }
}

/// An `m.room.encrypted` event reaches a handler only when it could not be decrypted.
async fn on_undecryptable(event: OriginalSyncRoomEncryptedEvent, room: Room, client: Client, Ctx(shared): Ctx<Shared>) {
    if room.state() != RoomState::Joined || Some(&*event.sender) == client.user_id() || !shared.is_allowed(&event.sender) {
        return;
    }
    let room_id = room.room_id().to_string();
    if shared.state.lock().unwrap().predates_join(&room_id, event.origin_server_ts.0.into()) {
        return;
    }
    warn!("could not decrypt {} in {room_id}", event.event_id);
    shared.emit(Event::Undecryptable { room_id, event_id: event.event_id.to_string(), sender: event.sender.to_string() });
}

/// Accepts invites from allowed users and ignores all others.
async fn on_invite(event: StrippedRoomMemberEvent, room: Room, client: Client, Ctx(shared): Ctx<Shared>) {
    if Some(&*event.state_key) != client.user_id() || room.state() != RoomState::Invited {
        return;
    }
    if !shared.is_allowed(&event.sender) {
        warn!("ignoring an invite to {} from {}", room.room_id(), event.sender);
        return;
    }
    if let Err(error) = shared.state.lock().unwrap().set_joined_at(room.room_id().as_str(), now_ms()) {
        warn!("recording the join of {} failed: {error:#}", room.room_id());
    }
    tokio::spawn(async move {
        // The invite can arrive before the homeserver lets us join, so retry for a while.
        let mut delay = Duration::from_secs(2);
        loop {
            match room.join().await {
                Ok(()) => return info!("joined {}", room.room_id()),
                Err(error) if delay > Duration::from_secs(60) => return warn!("giving up joining {}: {error}", room.room_id()),
                Err(error) => warn!("joining {} failed, retrying in {delay:?}: {error}", room.room_id()),
            }
            tokio::time::sleep(delay).await;
            delay *= 2;
        }
    });
}

/// Runs the agent's commands until its end of input.
async fn read_commands(client: Client, shared: Shared) -> Result<()> {
    let mut lines = BufReader::new(stdin()).lines();
    while let Some(line) = lines.next_line().await? {
        if line.trim().is_empty() {
            continue;
        }
        let command = match serde_json::from_str::<Command>(&line) {
            Ok(command) => command,
            Err(error) => {
                shared.emit(Event::Error { request_id: None, message: format!("unreadable command: {error}") });
                continue;
            }
        };
        match command {
            Command::Ack { event_id } => {
                if let Err(error) = shared.state.lock().unwrap().ack(&event_id) {
                    shared.emit(Event::Error { request_id: None, message: format!("acking {event_id} failed: {error:#}") });
                }
            }
            Command::Send { request_id, room_id, txn_id, body, notice } => {
                // Sends run beside each other: a slow one must not hold back acks or other rooms.
                let (client, shared) = (client.clone(), shared.clone());
                tokio::spawn(async move {
                    let event = match send(&client, &room_id, txn_id, body, notice).await {
                        Ok(event_id) => Event::Sent { request_id, event_id },
                        Err(error) => Event::Error { request_id: Some(request_id), message: format!("{error:#}") },
                    };
                    shared.emit(event);
                });
            }
            Command::SendVoice { request_id, room_id, txn_id, path, duration_ms, waveform } => {
                let (client, shared) = (client.clone(), shared.clone());
                tokio::spawn(async move {
                    let event = match send_voice(&client, &room_id, txn_id, &path, duration_ms, waveform).await {
                        Ok(event_id) => Event::Sent { request_id, event_id },
                        Err(error) => Event::Error { request_id: Some(request_id), message: format!("{error:#}") },
                    };
                    shared.emit(event);
                });
            }
            Command::Typing { room_id, on } => set_typing(&client, &shared, room_id, on),
        }
    }
    Ok(())
}

fn joined_room(client: &Client, room_id: &str) -> Result<Room> {
    let id = <&RoomId>::try_from(room_id).with_context(|| format!("{room_id} is not a room ID"))?;
    let room = client.get_room(id).with_context(|| format!("not in room {room_id}"))?;
    anyhow::ensure!(room.state() == RoomState::Joined, "not joined to room {room_id}");
    Ok(room)
}

async fn send(client: &Client, room_id: &str, txn_id: String, body: String, notice: bool) -> Result<String> {
    let room = joined_room(client, room_id)?;
    let content = if notice { RoomMessageEventContent::notice_markdown(body) } else { RoomMessageEventContent::text_markdown(body) };
    let result = room.send(content).with_transaction_id(OwnedTransactionId::from(txn_id)).await?;
    Ok(result.response.event_id.to_string())
}

/// Uploads the file (encrypted in an encrypted room) and sends it as a voice message. A retry under the same transaction
/// ID uploads again but still becomes one event.
async fn send_voice(client: &Client, room_id: &str, txn_id: String, path: &str, duration_ms: u64, waveform: Vec<f32>) -> Result<String> {
    let room = joined_room(client, room_id)?;
    let data = tokio::fs::read(path).await.with_context(|| format!("reading {path}"))?;
    let info = BaseAudioInfo {
        duration: Some(Duration::from_millis(duration_ms)),
        size: UInt::new(data.len() as u64),
        waveform: if waveform.is_empty() { None } else { Some(waveform) },
    };
    let config = AttachmentConfig::new().txn_id(OwnedTransactionId::from(txn_id)).info(AttachmentInfo::Voice(info));
    let mime: mime::Mime = "audio/ogg".parse().expect("a valid MIME type");
    let response = room.send_attachment("voice-message.ogg", &mime, data, config).await?;
    Ok(response.event_id.to_string())
}

/// A typing notice lasts a few seconds on the homeserver, so "on" keeps renewing it until "off".
fn set_typing(client: &Client, shared: &Shared, room_id: String, on: bool) {
    let mut typing = shared.typing.lock().unwrap();
    if let Some(task) = typing.remove(&room_id) {
        task.abort();
    }
    let Ok(room) = joined_room(client, &room_id) else { return };
    if on {
        typing.insert(
            room_id,
            tokio::spawn(async move {
                loop {
                    let _ = room.typing_notice(true).await;
                    tokio::time::sleep(Duration::from_secs(3)).await;
                }
            }),
        );
    } else {
        tokio::spawn(async move {
            let _ = room.typing_notice(false).await;
        });
    }
}
