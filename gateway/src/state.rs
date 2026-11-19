use std::collections::BTreeMap;
use std::io::Write;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

use crate::ipc::Message;

/// matrix-sdk stores its sync position as soon as it has processed a sync, so a message the agent had not stored yet
/// when the process died would never be offered again. The inbox closes that gap: a message is written here before it
/// is passed on, stays until the agent acks it, and is offered again at every start.
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Stored {
    #[serde(default)]
    inbox: BTreeMap<String, Message>,
    /// Messages older than the join are history, not requests.
    #[serde(default)]
    joined_at: BTreeMap<String, u64>,
}

#[derive(Debug)]
pub struct State {
    path: PathBuf,
    stored: Stored,
}

impl State {
    pub fn load(path: &Path) -> Result<Self> {
        let stored = match std::fs::read(path) {
            Ok(bytes) => serde_json::from_slice(&bytes).with_context(|| format!("parsing {}", path.display()))?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Stored::default(),
            Err(error) => return Err(error).with_context(|| format!("reading {}", path.display())),
        };
        Ok(Self { path: path.to_owned(), stored })
    }

    /// Written to a temporary file and renamed, so a crash leaves the old file or the new one, never half of one.
    fn save(&self) -> Result<()> {
        let tmp = self.path.with_extension("json.tmp");
        let mut file = std::fs::File::create(&tmp).with_context(|| format!("writing {}", tmp.display()))?;
        file.write_all(&serde_json::to_vec(&self.stored)?)?;
        file.sync_all()?;
        std::fs::rename(&tmp, &self.path).with_context(|| format!("replacing {}", self.path.display()))?;
        Ok(())
    }

    pub fn add(&mut self, message: &Message) -> Result<bool> {
        if self.stored.inbox.contains_key(&message.event_id) {
            return Ok(false);
        }
        self.stored.inbox.insert(message.event_id.clone(), message.clone());
        self.save()?;
        Ok(true)
    }

    pub fn has(&self, event_id: &str) -> bool {
        self.stored.inbox.contains_key(event_id)
    }

    pub fn ack(&mut self, event_id: &str) -> Result<()> {
        if self.stored.inbox.remove(event_id).is_some() {
            self.save()?;
        }
        Ok(())
    }

    pub fn unacked(&self) -> Vec<Message> {
        let mut messages: Vec<Message> = self.stored.inbox.values().cloned().collect();
        messages.sort_by_key(|message| message.ts);
        messages
    }

    pub fn set_joined_at(&mut self, room_id: &str, ts: u64) -> Result<()> {
        self.stored.joined_at.insert(room_id.to_owned(), ts);
        self.save()
    }

    pub fn predates_join(&self, room_id: &str, ts: u64) -> bool {
        self.stored.joined_at.get(room_id).is_some_and(|joined| ts < *joined)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn message(event_id: &str, ts: u64) -> Message {
        Message { room_id: "!r:example.org".into(), event_id: event_id.into(), body: "hi".into(), ts, audio: None, reply_to: None }
    }

    fn temp_path(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("matrix-gateway-test-{}-{name}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("gateway-state.json")
    }

    #[test]
    fn unacked_messages_survive_a_restart_and_acked_ones_do_not() {
        let path = temp_path("inbox");
        let _ = std::fs::remove_file(&path);

        let mut state = State::load(&path).unwrap();
        assert!(state.add(&message("$late", 20)).unwrap());
        assert!(state.add(&message("$early", 10)).unwrap());
        assert!(!state.add(&message("$early", 10)).unwrap());
        state.ack("$late").unwrap();

        let reopened = State::load(&path).unwrap();
        assert_eq!(reopened.unacked(), vec![message("$early", 10)]);
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn messages_from_before_the_join_are_history() {
        let path = temp_path("joined");
        let _ = std::fs::remove_file(&path);

        let mut state = State::load(&path).unwrap();
        state.set_joined_at("!r:example.org", 100).unwrap();
        let reopened = State::load(&path).unwrap();
        assert!(reopened.predates_join("!r:example.org", 99));
        assert!(!reopened.predates_join("!r:example.org", 100));
        // A room joined some other way has no record: nothing in it counts as history.
        assert!(!reopened.predates_join("!other:example.org", 1));
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }
}
