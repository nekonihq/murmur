//! BLE GATT peripheral (Linux/BlueZ via `bluer`).
//!
//! This module is the integration glue between the BlueZ GATT stack and the
//! transport-agnostic, unit-tested core (`conn`, `session`, `protocol`). It is
//! compiled only on Linux and **requires a real BlueZ adapter to validate** —
//! there is no host-side substitute on macOS/CI, which is why all wire-format
//! and flow-control correctness lives in the tested modules and this layer only
//! shuttles bytes.
//!
//! Layout:
//! - three GATT characteristics (`C2P` write, `P2C` notify, `CTRL` write+notify)
//!   as defined in `PROTOCOL.md`;
//! - write callbacks push raw frames into one inbound channel tagged by source;
//! - notify callbacks hand their writer to per-characteristic pump tasks;
//! - a single engine task owns the [`AuthHandler`], [`SessionManager`], and
//!   [`OutboundPump`] and drives everything.

use std::collections::BTreeSet;

use anyhow::{Context, Result};
use bluer::adv::Advertisement;
use bluer::gatt::local::{
    Application, Characteristic, CharacteristicNotify, CharacteristicNotifyMethod,
    CharacteristicWrite, CharacteristicWriteMethod, Service,
};
use bluer::Uuid;
use futures::FutureExt;
use tokio::select;
use tokio::sync::mpsc;
use tracing::{info, warn};

use crate::conn::{AuthHandler, Channel, OutboundPump};
use crate::protocol::messages::Credit;
use crate::protocol::{Frame, Opcode, Reassembler};
use crate::session::SessionManager;

pub const SERVICE_UUID: Uuid = Uuid::from_u128(0x6d75726d_0000_4000_8000_000000000001);
pub const C2P_UUID: Uuid = Uuid::from_u128(0x6d75726d_0000_4000_8000_000000000002);
pub const P2C_UUID: Uuid = Uuid::from_u128(0x6d75726d_0000_4000_8000_000000000003);
pub const CTRL_UUID: Uuid = Uuid::from_u128(0x6d75726d_0000_4000_8000_000000000004);

/// Conservative payload assumption until ATT MTU negotiation reports better.
/// BlueZ negotiates a higher MTU on connect; outbound fragments stay small here
/// for safety. Tune once MTU is read from the connection.
const ASSUMED_MTU: usize = 180;

/// Initial advertised local name.
const LOCAL_NAME: &str = "murmur";

pub struct Settings {
    pub psk: Vec<u8>,
    pub shell: String,
    pub adapter: Option<String>,
}

/// Which inbound (central→peripheral) characteristic a frame arrived on.
#[derive(Debug, Clone, Copy)]
enum InChar {
    C2p,
    Ctrl,
}

/// Run the peripheral until interrupted.
pub async fn run(settings: Settings) -> Result<()> {
    let session = bluer::Session::new().await.context("opening BlueZ session")?;
    let adapter = match &settings.adapter {
        Some(name) => session.adapter(name)?,
        None => session.default_adapter().await?,
    };
    adapter
        .set_powered(true)
        .await
        .context("powering adapter on")?;
    info!(adapter = %adapter.name(), "murmurd starting");

    // Inbound frames from both write characteristics funnel here.
    let (in_tx, in_rx) = mpsc::unbounded_channel::<(InChar, Vec<u8>)>();
    // Outbound encoded frames to each notify characteristic.
    let (p2c_tx, p2c_rx) = mpsc::unbounded_channel::<Vec<u8>>();
    let (ctrl_tx, ctrl_rx) = mpsc::unbounded_channel::<Vec<u8>>();

    let app = build_application(in_tx, p2c_rx, ctrl_rx);
    let _app_handle = adapter
        .serve_gatt_application(app)
        .await
        .context("registering GATT application")?;

    let mut adv = Advertisement {
        service_uuids: [SERVICE_UUID].into_iter().collect::<BTreeSet<_>>(),
        discoverable: Some(true),
        local_name: Some(LOCAL_NAME.to_string()),
        ..Default::default()
    };
    adv.tx_power = Some(0);
    let _adv_handle = adapter
        .advertise(adv)
        .await
        .context("starting advertisement")?;
    info!("advertising as '{LOCAL_NAME}' ({SERVICE_UUID})");

    let engine = engine(settings.psk, settings.shell, in_rx, p2c_tx, ctrl_tx);

    select! {
        _ = engine => warn!("engine task exited"),
        _ = tokio::signal::ctrl_c() => info!("shutting down"),
    }
    Ok(())
}

/// Build the GATT application: three characteristics wired to the channels.
fn build_application(
    in_tx: mpsc::UnboundedSender<(InChar, Vec<u8>)>,
    p2c_rx: mpsc::UnboundedReceiver<Vec<u8>>,
    ctrl_rx: mpsc::UnboundedReceiver<Vec<u8>>,
) -> Application {
    let c2p_tx = in_tx.clone();
    let ctrl_in_tx = in_tx;

    // Notify receivers are moved into the notify callbacks once a central
    // subscribes; wrap in a Mutex<Option<..>> so the FnMut callback can take it.
    let p2c_rx = std::sync::Arc::new(tokio::sync::Mutex::new(Some(p2c_rx)));
    let ctrl_rx = std::sync::Arc::new(tokio::sync::Mutex::new(Some(ctrl_rx)));

    let c2p = Characteristic {
        uuid: C2P_UUID,
        write: Some(CharacteristicWrite {
            write_without_response: true,
            write: true,
            method: CharacteristicWriteMethod::Fun(Box::new(move |value, _req| {
                let tx = c2p_tx.clone();
                async move {
                    let _ = tx.send((InChar::C2p, value));
                    Ok(())
                }
                .boxed()
            })),
            ..Default::default()
        }),
        ..Default::default()
    };

    let p2c = Characteristic {
        uuid: P2C_UUID,
        notify: Some(CharacteristicNotify {
            notify: CharacteristicNotifyMethod::Fun(Box::new(move |mut notifier| {
                let p2c_rx = p2c_rx.clone();
                async move {
                    if let Some(mut rx) = p2c_rx.lock().await.take() {
                        tokio::spawn(async move {
                            while let Some(bytes) = rx.recv().await {
                                if notifier.notify(bytes).await.is_err() {
                                    break;
                                }
                            }
                        });
                    }
                }
                .boxed()
            })),
            ..Default::default()
        }),
        ..Default::default()
    };

    let ctrl = Characteristic {
        uuid: CTRL_UUID,
        write: Some(CharacteristicWrite {
            write: true,
            write_without_response: true,
            method: CharacteristicWriteMethod::Fun(Box::new(move |value, _req| {
                let tx = ctrl_in_tx.clone();
                async move {
                    let _ = tx.send((InChar::Ctrl, value));
                    Ok(())
                }
                .boxed()
            })),
            ..Default::default()
        }),
        notify: Some(CharacteristicNotify {
            notify: CharacteristicNotifyMethod::Fun(Box::new(move |mut notifier| {
                let ctrl_rx = ctrl_rx.clone();
                async move {
                    if let Some(mut rx) = ctrl_rx.lock().await.take() {
                        tokio::spawn(async move {
                            while let Some(bytes) = rx.recv().await {
                                if notifier.notify(bytes).await.is_err() {
                                    break;
                                }
                            }
                        });
                    }
                }
                .boxed()
            })),
            ..Default::default()
        }),
        ..Default::default()
    };

    Application {
        services: vec![Service {
            uuid: SERVICE_UUID,
            primary: true,
            characteristics: vec![c2p, p2c, ctrl],
            ..Default::default()
        }],
        ..Default::default()
    }
}

/// The connection engine: owns the tested core and routes frames.
async fn engine(
    psk: Vec<u8>,
    shell: String,
    mut inbound: mpsc::UnboundedReceiver<(InChar, Vec<u8>)>,
    p2c_tx: mpsc::UnboundedSender<Vec<u8>>,
    ctrl_tx: mpsc::UnboundedSender<Vec<u8>>,
) {
    let mut auth = AuthHandler::new(psk);
    let (out_tx, mut out_rx) = mpsc::unbounded_channel();
    let mut sessions = SessionManager::new(out_tx, shell);
    let mut pump = OutboundPump::new(ASSUMED_MTU);
    let mut re_c2p = Reassembler::new();
    let mut re_ctrl = Reassembler::new();

    loop {
        select! {
            inbound = inbound.recv() => {
                let Some((chan, bytes)) = inbound else { break };
                let frame = match Frame::decode(&bytes) {
                    Ok(f) => f,
                    Err(e) => { warn!(?e, "dropping malformed frame"); continue; }
                };
                match chan {
                    InChar::Ctrl => {
                        if let Some(msg) = re_ctrl.push(frame) {
                            if msg.opcode == Opcode::Credit {
                                if auth.is_authenticated() {
                                    if let Ok(c) = serde_json::from_slice::<Credit>(&msg.payload) {
                                        for f in pump.grant(c.session_id, c.n) {
                                            send(&p2c_tx, &f);
                                        }
                                    }
                                }
                            } else {
                                for f in auth.handle(&msg) {
                                    send(&ctrl_tx, &f);
                                }
                            }
                        }
                    }
                    InChar::C2p => {
                        if let Some(msg) = re_c2p.push(frame) {
                            if auth.is_authenticated() {
                                sessions.handle(msg);
                            } else {
                                warn!("dropping pre-auth C2P frame");
                            }
                        }
                    }
                }
            }
            event = out_rx.recv() => {
                let Some(event) = event else { break };
                for f in pump.submit(event) {
                    send(&p2c_tx, &f);
                }
            }
        }
    }
}

fn send(tx: &mpsc::UnboundedSender<Vec<u8>>, frame: &Frame) {
    match frame.encode() {
        Ok(bytes) => {
            let _ = tx.send(bytes);
        }
        Err(e) => warn!(?e, "failed to encode outbound frame"),
    }
}

/// Map the outbound [`Channel`] enum to the right notify sender. (Auth replies
/// go to CTRL; session output to P2C — currently handled inline above, but the
/// helper documents the mapping for future routing changes.)
#[allow(dead_code)]
fn channel_of(opcode: Opcode) -> Channel {
    match opcode {
        Opcode::AuthChallenge | Opcode::AuthOk | Opcode::AuthFail => Channel::Ctrl,
        _ => Channel::P2c,
    }
}
