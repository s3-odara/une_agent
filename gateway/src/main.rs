mod audio;
mod call;
mod config;
mod ipc;
mod run;
mod session;
mod state;

use std::io::{BufRead, Write};
use std::path::PathBuf;

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};

#[derive(Parser)]
#[command(about = "Matrix gateway of the agent")]
struct Cli {
    #[command(subcommand)]
    command: Action,
}

#[derive(Subcommand)]
enum Action {
    /// Log in once with the account's password and store the session.
    Login {
        #[arg(long, default_value = "config.json")]
        config: PathBuf,
        /// The account's recovery key, to verify this device. Without it a fresh account gets a new key.
        #[arg(long, env = "MATRIX_RECOVERY_KEY")]
        recovery_key: Option<String>,
    },
    /// Verify the logged-in device with the account's recovery key.
    Recover {
        #[arg(long, default_value = "config.json")]
        config: PathBuf,
        #[arg(long, env = "MATRIX_RECOVERY_KEY")]
        recovery_key: String,
    },
    /// Sync and exchange JSON Lines with the agent on stdin and stdout.
    Run {
        #[arg(long, default_value = "config.json")]
        config: PathBuf,
    },
}

fn password() -> Result<String> {
    if let Ok(password) = std::env::var("MATRIX_PASSWORD") {
        return Ok(password);
    }
    eprint!("Matrix password (shown as typed; set MATRIX_PASSWORD to avoid the prompt): ");
    std::io::stderr().flush()?;
    let mut line = String::new();
    std::io::stdin()
        .lock()
        .read_line(&mut line)
        .context("reading the password")?;
    let password = line.trim_end_matches(['\r', '\n']).to_owned();
    anyhow::ensure!(!password.is_empty(), "no password given");
    Ok(password)
}

#[tokio::main]
async fn main() -> Result<()> {
    // Both rustls crypto providers are in the build (see Cargo.toml); without a choice, the first TLS use panics.
    rustls::crypto::aws_lc_rs::default_provider()
        .install_default()
        .expect("no crypto provider installed before");
    tracing_subscriber::fmt()
        .with_writer(std::io::stderr) // stdout carries the JSON Lines to the agent
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "warn,matrix_gateway=info".into()),
        )
        .init();

    match Cli::parse().command {
        Action::Login {
            config,
            recovery_key,
        } => {
            let config = config::Config::load(&config)?;
            session::login(&config, &password()?, recovery_key.as_deref()).await
        }
        Action::Recover {
            config,
            recovery_key,
        } => session::recover(&config::Config::load(&config)?, &recovery_key).await,
        Action::Run { config } => run::run(&config::Config::load(&config)?).await,
    }
}
