//! `murmurd` — the murmur daemon. Exposes an interactive shell and a one-shot
//! command runner over a custom BLE GATT service. The AI agent loop lives on the
//! phone; this daemon only executes what the phone sends.
//!
//! The protocol, session, auth, and config layers are platform-independent and
//! unit-tested anywhere (`cargo test`). The BLE peripheral uses BlueZ via
//! `bluer` and is compiled only on Linux.

mod auth;
mod config;
mod conn;
mod protocol;
mod session;

#[cfg(target_os = "linux")]
mod ble;

use std::path::PathBuf;

use clap::Parser;

#[derive(Parser, Debug)]
#[command(name = "murmurd", version, about = "murmur BLE remote shell daemon")]
struct Cli {
    /// Directory holding daemon state (the pre-shared key).
    #[arg(long, default_value = "/etc/murmur")]
    config_dir: PathBuf,

    /// Shell to spawn for interactive (pty) sessions.
    #[arg(long, default_value = "/bin/bash")]
    shell: String,

    /// Print pairing material for enrolling a phone, then exit.
    #[arg(long)]
    pair: bool,

    /// BLE adapter name (Linux only), e.g. `hci0`. Defaults to the first.
    #[arg(long)]
    adapter: Option<String>,
}

fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "murmurd=info".into()),
        )
        .init();

    let cli = Cli::parse();

    if cli.pair {
        return config::print_pairing(&cli.config_dir);
    }

    run(cli)
}

#[cfg(target_os = "linux")]
fn run(cli: Cli) -> anyhow::Result<()> {
    let psk = config::load_or_create_psk(&cli.config_dir)?;
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;
    runtime.block_on(ble::run(ble::Settings {
        psk,
        shell: cli.shell,
        adapter: cli.adapter,
    }))
}

#[cfg(not(target_os = "linux"))]
fn run(cli: Cli) -> anyhow::Result<()> {
    // Ensure config still works off-Linux (useful for development).
    let _ = config::load_or_create_psk(&cli.config_dir)?;
    eprintln!(
        "murmurd's BLE peripheral requires Linux/BlueZ; this is a {} build.\n\
         Protocol, session, auth and config logic are exercised by `cargo test`.",
        std::env::consts::OS
    );
    Ok(())
}
