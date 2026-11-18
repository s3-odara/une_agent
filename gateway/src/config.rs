use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use matrix_sdk::ruma::OwnedUserId;
use serde::Deserialize;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    pub matrix: MatrixConfig,
    #[serde(default = "default_data_dir")]
    data_dir: String,
    #[serde(skip)]
    base_dir: PathBuf,
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
}
