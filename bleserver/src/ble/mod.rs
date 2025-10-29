use anyhow::Result;
use btleplug::api::{Manager as _, Central};
use btleplug::platform::{Manager, Adapter};
use tokio::sync::mpsc;
use futures_util::stream::StreamExt;

pub mod events;
pub mod handlers;
use std::sync::atomic::AtomicBool;

pub(crate) static SCANNING: AtomicBool = AtomicBool::new(false);

pub async fn init() -> Result<(Adapter, mpsc::Receiver<btleplug::api::CentralEvent>)> {
    let manager = Manager::new().await?;
    let adapters = manager.adapters().await?;
    let central = adapters
        .get(0)
        .ok_or_else(|| anyhow::anyhow!("No BLE adapter found"))?
        .clone();


    let mut event_stream = central.events().await?;
    let (tx, rx) = mpsc::channel(64);

    tokio::spawn(async move {
        while let Some(e) = event_stream.next().await {
            let _ = tx.send(e).await;
        }
    });

    Ok((central, rx))
}
