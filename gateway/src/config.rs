use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use matrix_sdk::ruma::OwnedUserId;
use serde::Deserialize;

use crate::audio::VadConfig;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    pub matrix: MatrixConfig,
    #[serde(default = "default_data_dir")]
    data_dir: String,
    #[serde(default)]
    pub voice: Option<VoiceConfig>,
    #[serde(skip)]
    base_dir: PathBuf,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceConfig {
    #[serde(default)]
    pub call: Option<CallConfig>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CallConfig {
    #[serde(default)]
    pub vad: VadConfig,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MatrixConfig {
    pub homeserver: String,
    pub user_id: OwnedUserId,
    #[serde(default = "default_device_name")]
    pub device_name: String,
    /// Only these users can invite the bot and talk to it.
    pub allowed_users: Vec<OwnedUserId>,
}

fn default_data_dir() -> String {
    "data".to_owned()
}

fn default_device_name() -> String {
    "agent".to_owned()
}

impl Config {
    pub fn load(path: &Path) -> Result<Self> {
        let text = std::fs::read_to_string(path).with_context(|| format!("reading {}", path.display()))?;
        let mut config: Config = serde_json::from_str(&text).with_context(|| format!("parsing {}", path.display()))?;
        anyhow::ensure!(!config.matrix.allowed_users.is_empty(), "matrix.allowedUsers must list at least one user ID");
        let absolute = std::path::absolute(path)?;
        config.base_dir = absolute.parent().map(Path::to_owned).unwrap_or_default();
        Ok(config)
    }

    pub fn data_dir(&self) -> PathBuf {
        self.base_dir.join(&self.data_dir)
    }

    pub fn call_vad(&self) -> Option<VadConfig> {
        self.voice.as_ref()?.call.as_ref().map(|call| call.vad)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(extra: &str) -> Config {
        let json = format!(
            r#"{{ "matrix": {{ "homeserver": "https://example.org", "userId": "@bot:example.org", "allowedUsers": ["@me:example.org"] }}{extra} }}"#
        );
        serde_json::from_str(&json).unwrap()
    }

    #[test]
    fn call_vad_is_none_without_voice_call() {
        assert_eq!(parse("").call_vad(), None);
        assert_eq!(parse(r#", "voice": {}"#).call_vad(), None);
    }

    #[test]
    fn call_vad_uses_defaults_and_overrides() {
        assert_eq!(
            parse(r#", "voice": { "call": {} }"#).call_vad(),
            Some(VadConfig { threshold: 0.5, start_ms: 208, end_silence_ms: 1400, max_ms: 30_000, pre_roll_ms: 300 })
        );
        assert_eq!(
            parse(r#", "voice": { "call": { "vad": { "endSilenceMs": 700 } } }"#).call_vad(),
            Some(VadConfig { threshold: 0.5, start_ms: 208, end_silence_ms: 700, max_ms: 30_000, pre_roll_ms: 300 })
        );
    }
}
