use anyhow::Result;
use serde_json::json;
use serde_json::Value;
use btleplug::api::Peripheral as _;
use btleplug::platform::Adapter;
use crate::ipc::{IpcWriter, send_event};

use super::{make_response, extract_normalized_address,find_peripheral_by_normalized};

pub async fn handle(cmd: Value, adapter: &Adapter, out: &IpcWriter) -> Result<()> {
    let id = cmd.get("_id").cloned();
    let mut obj = make_response("services", id.clone());

    let norm = match extract_normalized_address(&cmd) {
        Ok(n) => n,
        Err(e) => {
            obj["error"] = json!(e);
            send_event(out, &obj).await?;
            return Ok(());
        }
    };

    match find_peripheral_by_normalized(adapter, &norm).await {
        Ok(Some((peripheral, _))) => {
            // Ask the peripheral to discover services, then read properties
            // and return the service UUIDs as an array of strings.
            if let Err(e) = peripheral.discover_services().await {
                obj["error"] = json!(format!("discover_services failed: {}", e));
            } else if let Ok(props_opt) = peripheral.properties().await {
                if let Some(props) = props_opt {
                    let services: Vec<Value> = props.services   
                        .iter()
                        .map(|u| Value::String(u.to_string()))
                        .collect();
                    obj["result"] = json!(services);
                } else {
                    obj["error"] = json!("no properties available after service discovery");
                }
            } else {
                obj["error"] = json!("failed to read peripheral properties");
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
