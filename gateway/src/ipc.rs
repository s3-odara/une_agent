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
    /// An allowed user reacted to an event. Not stored: one missed while the gateway was down is not offered again.
    Reaction { room_id: String, event_id: String, relates_to: String, key: String, sender: String },
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
    /// Reacts to an event with `key`; answered with `sent` (the reaction's event ID) or `error`.
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
    /// Plays a 48 kHz mono 16-bit WAV file in the room's call, after whatever is queued. The file is read at once.
    CallSpeak {
        room_id: String,
        id: String,
        path: String,
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
    use serde_json::Value;

    use super::*;

    /// The lines of `test/protocol.json`, which the agent's tests check against its own types.
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
