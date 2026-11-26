//! Keep in step with `src/gateway.ts`.

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncWriteExt, stdout};
use tokio::sync::mpsc;

use crate::audio::VadConfig;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Event {
    Ready {
        user_id: String,
        device_id: String,
        /// The largest upload the homeserver accepts, when it says; the agent keeps it to refuse early.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        upload_limit: Option<u64>,
    },
    Message(Message),
    Undecryptable { room_id: String, event_id: String },
    MediaFailed { room_id: String, event_id: String, reason: String },
    Sent { request_id: String, event_id: String },
    Error {
        #[serde(skip_serializing_if = "Option::is_none")]
        request_id: Option<String>,
        message: String,
    },
    /// Not stored: one missed while the gateway was down is not offered again.
    Reaction { room_id: String, event_id: String, relates_to: String, key: String },
    CallMembers { room_id: String, user_ids: Vec<String> },
    CallJoined { room_id: String },
    CallLeft { room_id: String, reason: String },
    CallSpeech { room_id: String },
    /// The agent deletes the file once done.
    CallUtterance { room_id: String, path: String, started_at: u64 },
    /// Played to the end, or not played at all because it could not be.
    CallSpoken { room_id: String, id: String },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub room_id: String,
    pub event_id: String,
    /// For a media message, the file name or description the sender's client gave it.
    pub body: String,
    pub ts: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attachment: Option<Media>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reply_to: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Media {
    /// The agent deletes it once it no longer needs it.
    pub path: String,
    pub mime_type: String,
    /// True only of a voice message.
    #[serde(default, skip_serializing_if = "is_false")]
    pub voice: bool,
}

fn is_false(value: &bool) -> bool {
    !*value
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VoiceInfo {
    pub duration_ms: u64,
    /// Each between 0 and 1, for the client to draw.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub waveform: Vec<f32>,
}

/// The file of a `sendAttachment` command; what the receiver's client makes of it follows the MIME type.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct File {
    pub path: String,
    pub name: String,
    pub mime_type: String,
    /// Of an image, when it is known.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
    /// Sent as a voice message, which must be an Ogg Opus file.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub voice: Option<VoiceInfo>,
}

#[derive(Debug, Deserialize, PartialEq)]
#[cfg_attr(test, derive(Serialize))]
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
        /// Sent as an edit of this event.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        replaces: Option<String>,
    },
    SendAttachment {
        request_id: String,
        room_id: String,
        txn_id: String,
        #[serde(flatten)]
        file: File,
    },
    Typing {
        room_id: String,
        on: bool,
    },
    React {
        request_id: String,
        room_id: String,
        txn_id: String,
        event_id: String,
        key: String,
    },
    JoinCall {
        room_id: String,
        vad: VadConfig,
    },
    LeaveCall {
        room_id: String,
    },
    /// The file is read at once.
    CallSpeak {
        room_id: String,
        id: String,
        path: String,
    },
}

pub type Outbox = mpsc::UnboundedSender<Event>;

/// The only writer of stdout, so lines never interleave.
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
    use serde_json::Value;

    use super::*;

    /// The agent's tests check the same file against its own types.
    fn examples(kind: &str) -> Vec<Value> {
        let all: Value = serde_json::from_str(include_str!("../../test/protocol.json")).unwrap();
        all[kind].as_array().unwrap().clone()
    }

    /// Read and written back unchanged: no field is missing, misnamed, dropped or added on either side.
    fn assert_round_trips<T: serde::de::DeserializeOwned + Serialize>(example: &Value) {
        let read: T = serde_json::from_value(example.clone()).unwrap_or_else(|error| panic!("{example}: {error}"));
        assert_eq!(&serde_json::to_value(&read).unwrap(), example);
    }

    #[test]
    fn every_event_is_written_as_the_agent_reads_it() {
        for example in examples("events") {
            assert_round_trips::<Event>(&example);
        }
    }

    #[test]
    fn every_command_the_agent_writes_is_read() {
        for example in examples("commands") {
            assert_round_trips::<Command>(&example);
        }
    }
}
