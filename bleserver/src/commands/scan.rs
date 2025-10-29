use anyhow::Result;
use serde_json::json;
use serde_json::Value;
use btleplug::api::{Central, ScanFilter};
use btleplug::platform::Adapter;
use crate::ipc::{IpcWriter, send_event};
use crate::ble::SCANNING;
use std::sync::atomic::Ordering;

pub async fn handle(cmd: Value, adapter: &Adapter, out: &IpcWriter) -> Result<()> {
    match cmd.get("cmd").and_then(|c| c.as_str()) {
        Some("scan") => {
            SCANNING.store(true, Ordering::SeqCst);
            if let Err(e) = adapter.start_scan(ScanFilter::default()).await {
                let err = json!({"_type":"error","message":format!("start_scan failed: {:?}", e)});
                send_event(out, &err).await?;
            }
        }
        Some("stopScan") => {
            SCANNING.store(false, Ordering::SeqCst);
            if let Err(e) = adapter.stop_scan().await {
                let err = json!({"_type":"error","message":format!("stop_scan failed: {:?}", e)});
                send_event(out, &err).await?;
            }
        }
        _ => {}
    }
    Ok(())
}
