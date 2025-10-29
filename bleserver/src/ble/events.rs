use btleplug::api::Peripheral as _;

use anyhow::Result;
use btleplug::api::{Central, CentralEvent, CentralState};
use btleplug::platform::Adapter;
use tokio::sync::mpsc::Receiver;
use crate::ipc::IpcWriter;
use std::sync::atomic::Ordering;


pub async fn handle_events(adapter: Adapter, mut event_rx: Receiver<CentralEvent>, out: IpcWriter) -> Result<()> {
    while let Some(evt) = event_rx.recv().await {
    // (debug logging removed)
        match evt {
            CentralEvent::DeviceDiscovered(id) | CentralEvent::DeviceUpdated(id) => {
                // Some systems don't emit an explicit StateUpdate event on startup
                // even though the adapter is powered on. Use the first discovered
                // device as evidence the adapter is active and notify the state
                // handler (which will only send Start once).
                let _ = super::handlers::handle_state_update("poweredOn", &out).await;

                if super::SCANNING.load(Ordering::SeqCst) {
                    if let Ok(peripheral) = adapter.peripheral(&id).await {
                        if let Some(props) = peripheral.properties().await.ok().flatten() {
                            // delegate to handlers
                            super::handlers::handle_discovered_props(props, &out).await?;
                        }
                    }
                }
            }
            CentralEvent::DeviceDisconnected(id) => {
                super::handlers::handle_disconnected(id.to_string(), &out).await?;
            }
            CentralEvent::StateUpdate(state) => {
                // Convert CentralState into the expected string values for the JSON payload.
                let state_str = match state {
                    CentralState::PoweredOn => "poweredOn",
                    CentralState::PoweredOff => "poweredOff",
                    _ => "unknown",
                };
                super::handlers::handle_state_update(state_str, &out).await?;
            }
            _ => {
                // Ignore all other events.
            }
        }
    }
    Ok(())
}
