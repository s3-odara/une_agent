use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use matrix_sdk::Client;
use matrix_sdk::authentication::matrix::MatrixSession;
use matrix_sdk::config::SyncSettings;
use matrix_sdk::encryption::recovery::RecoveryState;
use matrix_sdk::encryption::{BackupDownloadStrategy, EncryptionSettings};
use matrix_sdk_crypto::{CollectStrategy, DecryptionSettings, TrustRequirement};

use crate::config::Config;

fn session_path(data_dir: &Path) -> PathBuf {
    data_dir.join("matrix-session.json")
}

/// The store holds the E2EE keys, so the bot stays the same device across restarts.
async fn build_client(config: &Config) -> Result<Client> {
    let data_dir = config.data_dir();
    std::fs::create_dir_all(&data_dir).with_context(|| format!("creating {}", data_dir.display()))?;
    let client = Client::builder()
        .homeserver_url(&config.matrix.homeserver)
        .sqlite_store(data_dir.join("matrix-store"), None)
        .with_encryption_settings(EncryptionSettings {
            auto_enable_cross_signing: true,
            backup_download_strategy: BackupDownloadStrategy::AfterDecryptionFailure,
            auto_enable_backups: true,
        })
        .with_decryption_settings(DecryptionSettings {
            sender_device_trust_requirement: TrustRequirement::CrossSigned,
        })
        .with_room_key_recipient_strategy(CollectStrategy::IdentityBasedStrategy)
        .build()
        .await
        .context("building the Matrix client")?;
    Ok(client)
}

pub async fn restore(config: &Config) -> Result<Client> {
    let path = session_path(&config.data_dir());
    let bytes = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            bail!("no Matrix session at {}; run `matrix-gateway login` first", path.display())
        }
        Err(error) => return Err(error).with_context(|| format!("reading {}", path.display())),
    };
    let session: MatrixSession = serde_json::from_slice(&bytes).with_context(|| format!("parsing {}", path.display()))?;
    let client = build_client(config).await?;
    client.restore_session(session).await.context("restoring the Matrix session")?;
    Ok(client)
}

pub async fn login(config: &Config, password: &str, recovery_key: Option<&str>) -> Result<()> {
    let path = session_path(&config.data_dir());
    if path.exists() {
        bail!(
            "already logged in ({} exists). To log in again, sign that device out and delete the data directory.",
            path.display()
        );
    }
    let client = build_client(config).await?;
    client
        .matrix_auth()
        .login_username(&config.matrix.user_id, password)
        .initial_device_display_name(&config.matrix.device_name)
        .send()
        .await
        .context("logging in")?;

    let session = client.matrix_auth().session().context("the login returned no session")?;
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&path)
        .with_context(|| format!("writing {}", path.display()))?;
    file.write_all(&serde_json::to_vec(&session)?)?;
    file.sync_all()?;
    eprintln!("logged in as {} (device {})", session.meta.user_id, session.meta.device_id);

    client.encryption().wait_for_e2ee_initialization_tasks().await;
    client.sync_once(SyncSettings::default()).await.context("first sync")?;
    verify(&client, recovery_key).await
}

pub async fn recover(config: &Config, recovery_key: &str) -> Result<()> {
    let client = restore(config).await?;
    client.encryption().wait_for_e2ee_initialization_tasks().await;
    client.sync_once(SyncSettings::default()).await.context("sync")?;
    verify(&client, Some(recovery_key)).await
}

async fn verify(client: &Client, recovery_key: Option<&str>) -> Result<()> {
    let recovery = client.encryption().recovery();
    match (recovery_key, recovery.state()) {
        (Some(key), _) => {
            recovery.recover(key.trim()).await.context("recovering with the recovery key")?;
        }
        // A fresh account: this login created its cross-signing keys, so set up recovery for them too.
        (None, RecoveryState::Disabled) => {
            let key = recovery.enable().await.context("enabling recovery")?;
            eprintln!("\nRecovery key of this account. Keep it: it is the only way to verify another device.\n\n    {key}\n");
        }
        (None, RecoveryState::Enabled) => {}
        (None, state) => {
            eprintln!(
                "\nThis account already has recovery set up (state: {state:?}), and this device does not have its secrets.\n\
                 Verify the device with:  matrix-gateway recover --recovery-key '<key>'\n"
            );
        }
    }

    let device = client.encryption().get_own_device().await?.context("own device not found")?;
    if device.is_cross_signed_by_owner() {
        eprintln!("this device is verified");
    } else {
        eprintln!("warning: this device is NOT verified; other clients will flag its messages");
    }
    Ok(())
}
