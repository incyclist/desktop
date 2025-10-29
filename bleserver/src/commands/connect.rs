use anyhow::Result;
use serde_json::json;
use serde_json::Value;
use btleplug::api::Peripheral as _;
use btleplug::platform::Adapter;
use crate::ipc::{IpcWriter, send_event};

use super::{make_response, extract_normalized_address,find_peripheral_by_normalized};

pub async fn handle(cmd: Value, adapter: &Adapter, out: &IpcWriter) -> Result<()> {
    let id = cmd.get("_id").cloned();
    let mut obj = make_response("connect", id.clone());

    let norm = match extract_normalized_address(&cmd) {
        Ok(n) => n,
        Err(e) => {
            obj["error"] = json!(e);
            send_event(out, &obj).await?;
            return Ok(());
        }
    };

    match find_peripheral_by_normalized(adapter, &norm).await {
        Ok(Some((peripheral, formatted))) => {
            if let Err(e) = peripheral.connect().await {
                obj["error"] = json!(format!("connect failed: {}", e));
            } else {
                obj["result"] = json!(formatted.to_uppercase());
            }
        }
        Ok(None) => {
            obj["error"] = json!("peripheral not found");
        }
        Err(e) => {
            obj["error"] = json!(format!("failed to list peripherals: {}", e));
        }
    }

    send_event(out, &obj).await?;
    Ok(())
}
