use anyhow::Result;
use btleplug::api::Peripheral;
use serde_json::json;
use serde_json::Value;
use btleplug::platform::Adapter;
use btleplug::api::Characteristic;
use crate::ipc::{IpcWriter, send_event};
use super::{make_response, extract_normalized_address,find_peripheral_by_normalized};

fn get_uuid(cmd: &Value, key: &str) -> Option<String> {
    let service = cmd.get(key).cloned().map(|v| match v {
        Value::String(s) => s.replace('{', "").replace('}', ""),
        other => other.to_string(),
    });
    service
}


pub async fn handle(cmd: Value, adapter: &Adapter, out: &IpcWriter) -> Result<()> {
    let id = cmd.get("_id").cloned();
    
    let service_uuid = get_uuid(&cmd, "service");
    let characteristic_uuid = get_uuid(&cmd, "characteristic");
    let mut obj = make_response("read", id.clone());

    if let Some(ref uuid) = service_uuid {

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

                if peripheral.characteristics().is_empty() {
                    if let Err(e) = peripheral.discover_services().await {
                        obj["error"] = json!(format!("discover_services failed: {}", e));
                    }
                }


                if !peripheral.characteristics().is_empty() {

                    // find a characteristic based where service.uuid == service_uuid and characteristic.uuid == characteristic_uuid

                    let characteristics = peripheral.characteristics();
                    let target = characteristics
                        .iter()
                        .filter(|c| c.service_uuid.to_string() == *uuid)
                        .filter(|c| characteristic_uuid.as_ref().map(|s| s.to_string()) == Some(c.uuid.to_string()))
                        .collect::<Vec<&Characteristic>>();

                    // set errror if target is empty
                    if target.is_empty() {
                        obj["error"] = json!("characteristic not found");
                        send_event(out, &obj).await?;
                        return Ok(());
                    }
                    // get first value from target vector, 
                    let target = target.first().unwrap();

                    match peripheral.read(target).await {
                        Ok(value) => {
                            let data = hex::encode(value);
                            obj["result"] = json!(data);
                        }
                        Err(e) => {
                            obj["error"] = json!(format!("read failed: {}", e));
                        }
                    }
                    
                }

            }
            Ok(None) => {
                obj["error"] = json!("peripheral not found");
            }
            Err(e) => {
                obj["error"] = json!(format!("failed to list peripherals: {}", e));
            }
        }

    }
    else {
        obj["error"] = json!("missing service");
    }


    send_event(out, &obj).await?;
    Ok(())
}

