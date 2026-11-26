use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{Context, Result};
use matrix_sdk::attachment::{AttachmentConfig, AttachmentInfo, BaseAudioInfo, BaseFileInfo, BaseImageInfo, BaseVideoInfo};
use matrix_sdk::config::SyncSettings;
use matrix_sdk::event_handler::Ctx;
use matrix_sdk::ruma::api::error::ErrorKind;
use matrix_sdk::ruma::events::room::encrypted::OriginalSyncRoomEncryptedEvent;
use matrix_sdk::ruma::events::reaction::{OriginalSyncReactionEvent, ReactionEventContent};
use matrix_sdk::ruma::events::relation::Annotation;
use matrix_sdk::ruma::events::room::member::StrippedRoomMemberEvent;
use matrix_sdk::ruma::events::room::message::{MessageType, OriginalSyncRoomMessageEvent, Relation, ReplacementMetadata, RoomMessageEventContent};
use matrix_sdk::ruma::{EventId, OwnedEventId, OwnedTransactionId, OwnedUserId, RoomId, UInt};
use matrix_sdk::{Client, LoopCtrl, Room, RoomState};
use matrix_sdk::media::MediaEventContent;
use tokio::io::{AsyncBufReadExt, BufReader, stdin};
use tokio::task::JoinHandle;
use tracing::{info, warn};

use crate::call::{Calls, Control, now_ms, watch_memberships};
use crate::config::Config;
use crate::ipc::{Command, Event, File, Message, Media, Outbox, spawn_writer};
use crate::session;
use crate::state::State;

#[derive(Clone)]
struct Shared {
    out: Outbox,
    state: Arc<Mutex<State>>,
    allowed: Arc<Vec<OwnedUserId>>,
    media_dir: Arc<PathBuf>,
    typing: Arc<Mutex<HashMap<String, JoinHandle<()>>>>,
    calls: Calls,
}

impl Shared {
    fn emit(&self, event: Event) {
        // Fails only once the writer has stopped, which is when the agent is gone.
        let _ = self.out.send(event);
    }

    fn is_allowed(&self, user: &OwnedUserId) -> bool {
        self.allowed.contains(user)
    }

    fn accepts(&self, room: &Room, client: &Client, sender: &OwnedUserId, ts: u64) -> bool {
        room.state() == RoomState::Joined
            && Some(&**sender) != client.user_id()
            && self.is_allowed(sender)
            && !self.state.lock().unwrap().predates_join(room.room_id().as_str(), ts)
    }
}

pub async fn run(config: &Config) -> Result<()> {
    let client = session::restore(config).await?;
    let state = State::load(&config.data_dir().join("gateway-state.json"))?;
    let out = spawn_writer();
    let allowed = Arc::new(config.matrix.allowed_users.clone());
    let shared = Shared {
        calls: Calls::new(out.clone(), allowed.clone(), config.data_dir().join("voice").join("call")),
        out,
        state: Arc::new(Mutex::new(state)),
        allowed,
        media_dir: Arc::new(config.data_dir().join("files").join("in")),
        typing: Arc::default(),
    };

    let user_id = client.user_id().context("the session has no user")?.to_string();
    let device_id = client.device_id().context("the session has no device")?.to_string();
    // The limit is asked once, at the start; a homeserver that does not say leaves it unknown.
    let upload_limit = client.load_or_fetch_max_upload_size().await.ok().map(u64::from);
    shared.emit(Event::Ready { user_id, device_id, upload_limit });

    for message in shared.state.lock().unwrap().unacked() {
        shared.emit(Event::Message(message));
    }

    client.add_event_handler_context(shared.clone());
    client.add_event_handler(on_message);
    client.add_event_handler(on_undecryptable);
    client.add_event_handler(on_invite);
    client.add_event_handler(on_reaction);
    watch_memberships(&client, shared.out.clone(), shared.allowed.clone());

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

/// Older clients start a reply with the quoted message (`> <@user> ...`) and a blank line; the agent wants only what
/// was said.
fn without_reply_fallback(body: &str) -> &str {
    if !body.starts_with('>') {
        return body;
    }
    let mut rest = body;
    while rest.starts_with('>') {
        rest = rest.split_once('\n').map_or("", |(_, after)| after);
    }
    rest.strip_prefix('\n').unwrap_or(rest)
}

/// Larger media is refused rather than downloaded: a 20 MB attachment is already a lot for a chat.
const MAX_MEDIA_BYTES: u64 = 20 * 1024 * 1024;

/// A voice or media message is downloaded and decrypted first, so what the inbox holds is complete without the homeserver.
async fn on_message(event: OriginalSyncRoomMessageEvent, room: Room, client: Client, Ctx(shared): Ctx<Shared>) {
    let ts: u64 = event.origin_server_ts.0.into();
    // An edit is not a new request.
    if !shared.accepts(&room, &client, &event.sender, ts) || matches!(event.content.relates_to, Some(Relation::Replacement(_))) {
        return;
    }
    let room_id = room.room_id().to_string();
    let event_id = event.event_id.to_string();
    // Already passed on: a sync can repeat.
    if shared.state.lock().unwrap().has(&event_id) {
        return;
    }
    let reply_to = match &event.content.relates_to {
        Some(Relation::Reply(reply)) => Some(reply.in_reply_to.event_id.to_string()),
        _ => None,
    };
    let (body, attachment) = match &event.content.msgtype {
        MessageType::Text(text) if reply_to.is_some() => (without_reply_fallback(&text.body).to_owned(), None),
        MessageType::Text(text) => (text.body.clone(), None),
        MessageType::Audio(content) => {
            let mimetype = content.info.as_deref().and_then(|info| info.mimetype.as_deref());
            match receive_media(&client, &shared, &room_id, &event_id, &content.body, content, mimetype, content.voice.is_some()).await {
                Some(pair) => pair,
                None => return,
            }
        }
        MessageType::Image(content) => {
            let mimetype = content.info.as_deref().and_then(|info| info.mimetype.as_deref());
            match receive_media(&client, &shared, &room_id, &event_id, &content.body, content, mimetype, false).await {
                Some(pair) => pair,
                None => return,
            }
        }
        MessageType::File(content) => {
            let mimetype = content.info.as_deref().and_then(|info| info.mimetype.as_deref());
            match receive_media(&client, &shared, &room_id, &event_id, &content.body, content, mimetype, false).await {
                Some(pair) => pair,
                None => return,
            }
        }
        MessageType::Video(content) => {
            let mimetype = content.info.as_deref().and_then(|info| info.mimetype.as_deref());
            match receive_media(&client, &shared, &room_id, &event_id, &content.body, content, mimetype, false).await {
                Some(pair) => pair,
                None => return,
            }
        }
        _ => return,
    };
    let message = Message { room_id, event_id, body, ts, attachment, reply_to };

    let added = shared.state.lock().unwrap().add(&message);
    match added {
        Ok(true) => shared.emit(Event::Message(message)),
        Ok(false) => {}
        Err(error) => shared.emit(Event::Error { request_id: None, message: format!("storing {} failed: {error:#}", message.event_id) }),
    }
}

async fn receive_media(
    client: &Client,
    shared: &Shared,
    room_id: &str,
    event_id: &str,
    body: &str,
    content: &impl MediaEventContent,
    mimetype: Option<&str>,
    voice: bool,
) -> Option<(String, Option<Media>)> {
    match download_media(client, &shared.media_dir, event_id, content, mimetype, voice).await {
        Ok(media) => Some((body.to_owned(), Some(media))),
        Err(error) => {
            warn!("downloading the media of {event_id} failed: {error:#}");
            shared.emit(Event::MediaFailed { room_id: room_id.to_owned(), event_id: event_id.to_owned(), reason: format!("{error:#}") });
            None
        }
    }
}

fn parse_mime(mimetype: Option<&str>) -> mime::Mime {
    mimetype
        .filter(|mime| mime.contains('/') && !mime.eq_ignore_ascii_case("application/octet-stream"))
        .and_then(|mime| mime.parse::<mime::Mime>().ok())
        .unwrap_or(mime::APPLICATION_OCTET_STREAM)
}

/// A media message is downloaded and decrypted first, so what the inbox holds is complete without the homeserver.
async fn download_media(client: &Client, dir: &Path, event_id: &str, content: &impl MediaEventContent, mimetype: Option<&str>, voice: bool) -> Result<Media> {
    let data = client.media().get_file(content, false).await?.context("the message has no file")?;
    anyhow::ensure!(data.len() as u64 <= MAX_MEDIA_BYTES, "the attachment is {} bytes, more than {MAX_MEDIA_BYTES}", data.len());
    let mime = parse_mime(mimetype);
    let filename = if voice { format!("{}.audio", file_stem(event_id)) } else { format!("{}.{}", file_stem(event_id), extension(&mime)) };
    let path = dir.join(filename);
    tokio::fs::create_dir_all(dir).await.with_context(|| format!("creating {}", dir.display()))?;
    tokio::fs::write(&path, data).await.with_context(|| format!("writing {}", path.display()))?;
    Ok(Media { path: path.to_string_lossy().into_owned(), mime_type: mime.essence_str().to_owned(), voice })
}

fn extension(mime: &mime::Mime) -> String {
    mime_guess::get_mime_extensions_str(mime.essence_str())
        .and_then(|extensions| extensions.first().copied())
        .unwrap_or("bin")
        .to_owned()
}

fn file_stem(event_id: &str) -> String {
    event_id.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' }).collect()
}

/// An `m.room.encrypted` event reaches a handler only when it could not be decrypted.
async fn on_undecryptable(event: OriginalSyncRoomEncryptedEvent, room: Room, client: Client, Ctx(shared): Ctx<Shared>) {
    if !shared.accepts(&room, &client, &event.sender, event.origin_server_ts.0.into()) {
        return;
    }
    let room_id = room.room_id().to_string();
    warn!("could not decrypt {} in {room_id}", event.event_id);
    shared.emit(Event::Undecryptable { room_id, event_id: event.event_id.to_string() });
}

/// The agent answers approval requests with them.
async fn on_reaction(event: OriginalSyncReactionEvent, room: Room, client: Client, Ctx(shared): Ctx<Shared>) {
    if !shared.accepts(&room, &client, &event.sender, event.origin_server_ts.0.into()) {
        return;
    }
    let room_id = room.room_id().to_string();
    shared.emit(Event::Reaction {
        room_id,
        event_id: event.event_id.to_string(),
        relates_to: event.content.relates_to.event_id.to_string(),
        key: event.content.relates_to.key,
    });
}

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
            Command::Send { request_id, room_id, txn_id, body, notice, replaces } => {
                let client = client.clone();
                respond(&shared, request_id, async move { send(&client, &room_id, txn_id, body, notice, replaces).await });
            }
            Command::SendAttachment { request_id, room_id, txn_id, file } => {
                let client = client.clone();
                respond(&shared, request_id, async move { send_attachment(&client, &room_id, txn_id, &file).await });
            }
            Command::Typing { room_id, on } => set_typing(&client, &shared, room_id, on),
            Command::React { request_id, room_id, txn_id, event_id, key } => {
                let client = client.clone();
                respond(&shared, request_id, async move { react(&client, &room_id, txn_id, &event_id, key).await });
            }
            Command::JoinCall { room_id, vad } => match joined_room(&client, &room_id) {
                Ok(room) => shared.calls.join(room, vad),
                Err(error) => shared.emit(Event::CallLeft { room_id, reason: format!("{error:#}") }),
            },
            Command::LeaveCall { room_id } => {
                // Not in a call there: nothing to leave.
                let _ = shared.calls.control(&room_id, Control::Leave);
            }
            Command::CallSpeak { room_id, id, path } => {
                if let Err(error) = shared.calls.control(&room_id, Control::Speak { id: id.clone(), path }) {
                    shared.emit(Event::CallSpoken { room_id, id });
                    warn!("{error:#}");
                }
            }
        }
    }
    Ok(())
}

/// Spawned, so a slow send does not hold back acks or other rooms.
fn respond(shared: &Shared, request_id: String, request: impl Future<Output = Result<String>> + Send + 'static) {
    let shared = shared.clone();
    tokio::spawn(async move {
        let event = match request.await {
            Ok(event_id) => Event::Sent { request_id, event_id },
            Err(error) => Event::Error { request_id: Some(request_id), message: format!("{error:#}") },
        };
        shared.emit(event);
    });
}

fn parse_event_id(id: &str) -> Result<OwnedEventId> {
    Ok(<&EventId>::try_from(id).with_context(|| format!("{id} is not an event ID"))?.to_owned())
}

fn joined_room(client: &Client, room_id: &str) -> Result<Room> {
    let id = <&RoomId>::try_from(room_id).with_context(|| format!("{room_id} is not a room ID"))?;
    let room = client.get_room(id).with_context(|| format!("not in room {room_id}"))?;
    anyhow::ensure!(room.state() == RoomState::Joined, "not joined to room {room_id}");
    Ok(room)
}

async fn send(client: &Client, room_id: &str, txn_id: String, body: String, notice: bool, replaces: Option<String>) -> Result<String> {
    let room = joined_room(client, room_id)?;
    let mut content = if notice { RoomMessageEventContent::notice_markdown(body) } else { RoomMessageEventContent::text_markdown(body) };
    if let Some(event_id) = replaces {
        content = content.make_replacement(ReplacementMetadata::new(parse_event_id(&event_id)?, None));
    }
    let result = room.send(content).with_transaction_id(OwnedTransactionId::from(txn_id)).await?;
    Ok(result.response.event_id.to_string())
}

async fn react(client: &Client, room_id: &str, txn_id: String, event_id: &str, key: String) -> Result<String> {
    let room = joined_room(client, room_id)?;
    let content = ReactionEventContent::new(Annotation::new(parse_event_id(event_id)?, key));
    let result = room.send(content).with_transaction_id(OwnedTransactionId::from(txn_id)).await?;
    Ok(result.response.event_id.to_string())
}

async fn send_attachment(client: &Client, room_id: &str, txn_id: String, file: &File) -> Result<String> {
    let room = joined_room(client, room_id)?;
    let data = tokio::fs::read(&file.path).await.with_context(|| format!("reading {}", file.path))?;
    let mime: mime::Mime = file.mime_type.parse().context("a MIME type the client gave is not one")?;
    let size = UInt::new(data.len() as u64);
    let info = if let Some(voice) = &file.voice {
        AttachmentInfo::Voice(BaseAudioInfo {
            duration: Some(Duration::from_millis(voice.duration_ms)),
            size,
            waveform: if voice.waveform.is_empty() { None } else { Some(voice.waveform.clone()) },
        })
    } else if mime.type_() == "image" {
        AttachmentInfo::Image(BaseImageInfo { width: file.width.map(UInt::from), height: file.height.map(UInt::from), size, blurhash: None, is_animated: None })
    } else if mime.type_() == "audio" {
        AttachmentInfo::Audio(BaseAudioInfo { duration: None, size, waveform: None })
    } else if mime.type_() == "video" {
        AttachmentInfo::Video(BaseVideoInfo { duration: None, height: file.height.map(UInt::from), width: file.width.map(UInt::from), size, blurhash: None })
    } else {
        AttachmentInfo::File(BaseFileInfo { size })
    };
    // A retry under the same transaction ID uploads again but still becomes one event.
    let config = AttachmentConfig::new().txn_id(OwnedTransactionId::from(txn_id)).info(info);
    let response = room.send_attachment(&file.name, &mime, data, config).await?;
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

#[cfg(test)]
mod tests {
    use super::{parse_mime, without_reply_fallback};

    #[test]
    fn a_reply_loses_the_quote_it_starts_with() {
        assert_eq!(without_reply_fallback("> <@bot:example.org> コードを送って\n> 二行目\n\nAB12"), "AB12");
        assert_eq!(without_reply_fallback("AB12"), "AB12");
        assert_eq!(without_reply_fallback("a > b"), "a > b");
    }

    #[test]
    fn invalid_or_missing_mime_falls_back_to_octet_stream() {
        assert_eq!(parse_mime(Some("image/png")).essence_str(), "image/png");
        assert_eq!(parse_mime(Some("not a mime/type; broken=")).essence_str(), "application/octet-stream");
        assert_eq!(parse_mime(None).essence_str(), "application/octet-stream");
    }
}
