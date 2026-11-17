//! The JSON Lines the gateway exchanges with the agent over stdout and stdin. Keep in step with `src/gateway.ts`.

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncWriteExt, stdout};
use tokio::sync::mpsc;

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
}

/// A text message from an allowed user.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub room_id: String,
    pub event_id: String,
    pub sender: String,
    pub body: String,
    /// `origin_server_ts`, milliseconds.
    pub ts: u64,
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
    Typing {
        room_id: String,
        on: bool,
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
        });
        assert_eq!(
            serde_json::to_string(&message).unwrap(),
            r#"{"type":"message","roomId":"!r:example.org","eventId":"$e","sender":"@me:example.org","body":"hi","ts":5}"#
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
            serde_json::from_str::<Command>(r#"{"type":"typing","roomId":"!r:example.org","on":true}"#).unwrap(),
            Command::Typing { room_id: "!r:example.org".into(), on: true }
        );
    }
}
