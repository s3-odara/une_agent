use std::collections::BTreeMap;
use std::io::Write;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

use crate::ipc::Message;

/// Sliding sync does not persist its position across restarts, so the latest timeline events arrive again on startup.
/// `default_cutoff` and per-room `cutoffs` reject already-processed and pre-join history, while `inbox` keeps unacked
/// messages across crashes.
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Stored {
    #[serde(default)]
    inbox: BTreeMap<String, Message>,
    #[serde(default)]
    default_cutoff: u64,
    #[serde(default)]
    cutoffs: BTreeMap<String, Cutoff>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Cutoff {
    ts: u64,
    #[serde(default)]
    seen: Vec<String>,
}

#[derive(Debug)]
pub struct State {
    path: PathBuf,
    stored: Stored,
}

impl State {
    pub fn load(path: &Path, now_ms: u64) -> Result<Self> {
        let mut stored = match std::fs::read(path) {
            Ok(bytes) => serde_json::from_slice(&bytes).with_context(|| format!("parsing {}", path.display()))?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Stored::default(),
            Err(error) => return Err(error).with_context(|| format!("reading {}", path.display())),
        };
        let needs_init = stored.default_cutoff == 0;
        if needs_init {
            stored.default_cutoff = now_ms;
        }
        let state = Self { path: path.to_owned(), stored };
        if needs_init {
            state.save()?;
        }
        Ok(state)
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

    pub fn is_seen_or_old(&self, room_id: &str, event_id: &str, ts: u64) -> bool {
        if self.stored.inbox.contains_key(event_id) {
            return true;
        }
        match self.stored.cutoffs.get(room_id) {
            Some(cutoff) => ts < cutoff.ts || (ts == cutoff.ts && cutoff.seen.iter().any(|id| id == event_id)),
            None => ts < self.stored.default_cutoff,
        }
    }

    pub fn record_seen(&mut self, room_id: &str, event_id: &str, ts: u64) -> Result<()> {
        self.advance_cutoff(room_id, ts, Some(event_id));
        self.save()
    }

    pub fn set_room_cutoff(&mut self, room_id: &str, ts: u64) -> Result<()> {
        self.advance_cutoff(room_id, ts, None);
        self.save()
    }

    pub fn add(&mut self, message: &Message) -> Result<bool> {
        if self.is_seen_or_old(&message.room_id, &message.event_id, message.ts) {
            return Ok(false);
        }
        self.stored.inbox.insert(message.event_id.clone(), message.clone());
        self.advance_cutoff(&message.room_id, message.ts, Some(&message.event_id));
        self.save()?;
        Ok(true)
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

    fn advance_cutoff(&mut self, room_id: &str, ts: u64, event_id: Option<&str>) {
        let cutoff = self.stored.cutoffs.entry(room_id.to_owned()).or_insert_with(|| Cutoff {
            ts: self.stored.default_cutoff,
            seen: Vec::new(),
        });
        if ts > cutoff.ts {
            cutoff.ts = ts;
            cutoff.seen.clear();
            if let Some(id) = event_id {
                cutoff.seen.push(id.to_owned());
            }
        } else if ts == cutoff.ts
            && let Some(id) = event_id
            && !cutoff.seen.iter().any(|seen| seen == id)
        {
            cutoff.seen.push(id.to_owned());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn message(event_id: &str, ts: u64) -> Message {
        Message { room_id: "!r:example.org".into(), event_id: event_id.into(), body: "hi".into(), ts, attachment: None, reply_to: None }
    }

    fn temp_path(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("matrix-gateway-test-{}-{name}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("gateway-state.json")
    }

    #[test]
    fn unacked_messages_survive_a_restart_and_acked_ones_do_not_retrigger() {
        let path = temp_path("inbox");
        let _ = std::fs::remove_file(&path);

        let mut state = State::load(&path, 1).unwrap();
        assert!(state.add(&message("$early", 10)).unwrap());
        assert!(state.add(&message("$late", 20)).unwrap());
        assert!(!state.add(&message("$early", 10)).unwrap());
        state.ack("$late").unwrap();

        let mut reopened = State::load(&path, 999).unwrap();
        assert_eq!(reopened.unacked(), vec![message("$early", 10)]);
        assert!(!reopened.add(&message("$late", 20)).unwrap());
        assert!(reopened.add(&message("$new", 21)).unwrap());
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn events_from_before_initial_start_or_join_are_ignored() {
        let path = temp_path("cutoff");
        let _ = std::fs::remove_file(&path);

        let mut state = State::load(&path, 100).unwrap();
        assert!(state.is_seen_or_old("!existing:example.org", "$old", 99));
        assert!(!state.is_seen_or_old("!existing:example.org", "$fresh", 100));

        state.set_room_cutoff("!joined:example.org", 200).unwrap();
        let reopened = State::load(&path, 500).unwrap();
        assert!(reopened.is_seen_or_old("!joined:example.org", "$pre", 199));
        assert!(!reopened.is_seen_or_old("!joined:example.org", "$at", 200));
        assert!(!reopened.is_seen_or_old("!existing:example.org", "$still_new", 150));
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn distinct_events_at_the_same_timestamp_are_each_accepted_once() {
        let path = temp_path("same-ts");
        let _ = std::fs::remove_file(&path);

        let mut state = State::load(&path, 10).unwrap();
        assert!(!state.is_seen_or_old("!r:example.org", "$a", 50));
        state.record_seen("!r:example.org", "$a", 50).unwrap();
        assert!(state.is_seen_or_old("!r:example.org", "$a", 50));
        assert!(!state.is_seen_or_old("!r:example.org", "$b", 50));
        state.record_seen("!r:example.org", "$b", 50).unwrap();

        let reopened = State::load(&path, 999).unwrap();
        assert!(reopened.is_seen_or_old("!r:example.org", "$a", 50));
        assert!(reopened.is_seen_or_old("!r:example.org", "$b", 50));
        assert!(!reopened.is_seen_or_old("!r:example.org", "$c", 50));
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }
}
