//! The JSON Lines the gateway exchanges with the agent over stdout and stdin. Keep in step with `src/gateway.ts`.

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncWriteExt, stdout};
use tokio::sync::mpsc;

use crate::audio::VadConfig;

/// A line the gateway writes.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Event {
    Ready { user_id: String, device_id: String },
    Message(Message),
    Undecryptable { room_id: String, event_id: String, sender: String },
    Sent { request_id: String, event_id: String },
    Error {
        #[serde(skip_serializing_if = "Option::is_none")]
        request_id: Option<String>,
        message: String,
    },
    /// The allowed users (not the bot) now in the room's call; empty once they have all left.
    CallMembers { room_id: String, user_ids: Vec<String> },
    CallJoined { room_id: String },
    /// The bot is out of the call: `reason` is empty when it left as asked or because everyone else did.
    CallLeft { room_id: String, reason: String },
    /// A participant started speaking. Whatever the bot was saying has been stopped.
    CallSpeech { room_id: String, user_id: String },
    /// One utterance, as a 16 kHz mono WAV file. The agent deletes it once done.
    CallUtterance { room_id: String, user_id: String, path: String, started_at: u64, duration_ms: u64 },
    /// A `callSpeak` finished playing, or was cut off (`interrupted`) after `played_ms`.
    CallSpoken { room_id: String, id: String, played_ms: u64, interrupted: bool },
}

/// A text or voice message from an allowed user.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub room_id: String,
    pub event_id: String,
    pub sender: String,
    /// The text; for audio, the file name or description the sender's client gave it.
    pub body: String,
    /// `origin_server_ts`, milliseconds.
    pub ts: u64,
    /// Present for an audio message: the recording, already downloaded and decrypted.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub audio: Option<Audio>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Audio {
    /// Absolute path of the file. The agent deletes it once it no longer needs it.
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mimetype: Option<String>,
    /// Whether the sender's client marked it as a voice message rather than an audio file.
    pub voice: bool,
}

/// A line the gateway reads.
#[derive(Debug, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Command {
    Ack {
        event_id: String,
    },
    Send {
        request_id: String,
        room_id: String,
        /// Matrix transaction ID; the homeserver sends one event per ID, however often it is retried.
        txn_id: String,
        body: String,
        #[serde(default)]
        notice: bool,
    },
    /// Sends an Ogg Opus file as a voice message.
    SendVoice {
        request_id: String,
        room_id: String,
        txn_id: String,
        path: String,
        duration_ms: u64,
        /// Loudness over time, each between 0 and 1, for the client to draw.
        #[serde(default)]
        waveform: Vec<f32>,
    },
    Typing {
        room_id: String,
        on: bool,
    },
    JoinCall {
        room_id: String,
        #[serde(default)]
        vad: VadConfig,
    },
    LeaveCall {
        room_id: String,
    },
    /// Plays a 48 kHz mono 16-bit WAV file in the room's call, after whatever is queued. The file is read at once.
    CallSpeak {
        room_id: String,
        id: String,
        path: String,
    },
    /// Stops what the bot is saying in the call, and what is queued.
    CallHush {
        room_id: String,
    },
}

pub type Outbox = mpsc::UnboundedSender<Event>;

/// Starts the only writer of stdout: one JSON object per line, in the order sent.
pub fn spawn_writer() -> Outbox {
    let (tx, mut rx) = mpsc::unbounded_channel::<Event>();
    tokio::spawn(async move {
        let mut out = stdout();
        while let Some(event) = rx.recv().await {
            let mut line = serde_json::to_vec(&event).expect("events serialize");
            line.push(b'\n');
            if out.write_all(&line).await.is_err() || out.flush().await.is_err() {
                // The agent is gone; the stdin reader ends the process.
                break;
            }
        }
    });
    tx
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn events_use_the_field_names_the_agent_reads() {
        let message = Event::Message(Message {
            room_id: "!r:example.org".into(),
            event_id: "$e".into(),
            sender: "@me:example.org".into(),
            body: "hi".into(),
            ts: 5,
            audio: None,
        });
        assert_eq!(
            serde_json::to_string(&message).unwrap(),
            r#"{"type":"message","roomId":"!r:example.org","eventId":"$e","sender":"@me:example.org","body":"hi","ts":5}"#
        );
        let voice = Event::Message(Message {
            room_id: "!r:example.org".into(),
            event_id: "$v".into(),
            sender: "@me:example.org".into(),
            body: "Voice message.ogg".into(),
            ts: 6,
            audio: Some(Audio { path: "/d/voice/in/v.ogg".into(), mimetype: Some("audio/ogg".into()), voice: true }),
        });
        assert_eq!(
            serde_json::to_string(&voice).unwrap(),
            r#"{"type":"message","roomId":"!r:example.org","eventId":"$v","sender":"@me:example.org","body":"Voice message.ogg","ts":6,"audio":{"path":"/d/voice/in/v.ogg","mimetype":"audio/ogg","voice":true}}"#
        );
        let sent = Event::Sent { request_id: "reply:$e".into(), event_id: "$s".into() };
        assert_eq!(serde_json::to_string(&sent).unwrap(), r#"{"type":"sent","requestId":"reply:$e","eventId":"$s"}"#);
        let error = Event::Error { request_id: None, message: "boom".into() };
        assert_eq!(serde_json::to_string(&error).unwrap(), r#"{"type":"error","message":"boom"}"#);
    }

    #[test]
    fn commands_parse_from_the_lines_the_agent_writes() {
        assert_eq!(
            serde_json::from_str::<Command>(r#"{"type":"ack","eventId":"$e"}"#).unwrap(),
            Command::Ack { event_id: "$e".into() }
        );
        assert_eq!(
            serde_json::from_str::<Command>(
                r#"{"type":"send","requestId":"reply:$e","roomId":"!r:example.org","txnId":"reply:$e","body":"hello","notice":false}"#
            )
            .unwrap(),
            Command::Send {
                request_id: "reply:$e".into(),
                room_id: "!r:example.org".into(),
                txn_id: "reply:$e".into(),
                body: "hello".into(),
                notice: false,
            }
        );
        assert_eq!(
            serde_json::from_str::<Command>(
                r#"{"type":"sendVoice","requestId":"voice:$e","roomId":"!r:example.org","txnId":"voice:$e","path":"/d/v.ogg","durationMs":1500,"waveform":[0.5]}"#
            )
            .unwrap(),
            Command::SendVoice {
                request_id: "voice:$e".into(),
                room_id: "!r:example.org".into(),
                txn_id: "voice:$e".into(),
                path: "/d/v.ogg".into(),
                duration_ms: 1500,
                waveform: vec![0.5],
            }
        );
        assert_eq!(
            serde_json::from_str::<Command>(r#"{"type":"typing","roomId":"!r:example.org","on":true}"#).unwrap(),
            Command::Typing { room_id: "!r:example.org".into(), on: true }
        );
        assert_eq!(
            serde_json::from_str::<Command>(
                r#"{"type":"joinCall","roomId":"!r:example.org","vad":{"threshold":0.6,"startMs":200,"endSilenceMs":700,"minSpeechMs":300,"maxMs":20000,"preRollMs":250}}"#
            )
            .unwrap(),
            Command::JoinCall {
                room_id: "!r:example.org".into(),
                vad: VadConfig { threshold: 0.6, start_ms: 200, end_silence_ms: 700, min_speech_ms: 300, max_ms: 20_000, pre_roll_ms: 250 },
            }
        );
        assert_eq!(
            serde_json::from_str::<Command>(r#"{"type":"callSpeak","roomId":"!r:example.org","id":"s1","path":"/d/s1.wav"}"#).unwrap(),
            Command::CallSpeak { room_id: "!r:example.org".into(), id: "s1".into(), path: "/d/s1.wav".into() }
        );
    }

    #[test]
    fn call_events_use_the_field_names_the_agent_reads() {
        let utterance = Event::CallUtterance {
            room_id: "!r:example.org".into(),
            user_id: "@me:example.org".into(),
            path: "/d/u.wav".into(),
            started_at: 5,
            duration_ms: 1200,
        };
        assert_eq!(
            serde_json::to_string(&utterance).unwrap(),
            r#"{"type":"callUtterance","roomId":"!r:example.org","userId":"@me:example.org","path":"/d/u.wav","startedAt":5,"durationMs":1200}"#
        );
        let spoken = Event::CallSpoken { room_id: "!r:example.org".into(), id: "s1".into(), played_ms: 900, interrupted: true };
        assert_eq!(
            serde_json::to_string(&spoken).unwrap(),
            r#"{"type":"callSpoken","roomId":"!r:example.org","id":"s1","playedMs":900,"interrupted":true}"#
        );
        let members = Event::CallMembers { room_id: "!r:example.org".into(), user_ids: vec!["@me:example.org".into()] };
        assert_eq!(serde_json::to_string(&members).unwrap(), r#"{"type":"callMembers","roomId":"!r:example.org","userIds":["@me:example.org"]}"#);
    }
}
