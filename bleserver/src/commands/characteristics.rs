use anyhow::Result;
use btleplug::api::CharPropFlags;
use serde_json::json;
use serde_json::Value;
use btleplug::api::Peripheral as _;
use btleplug::platform::Adapter;
use btleplug::api::Characteristic;
use std::collections::BTreeSet;
use crate::ipc::{IpcWriter, send_event};
use crate::utils::normalize_uuid;
use uuid::Uuid;
use super::{make_response, extract_normalized_address,find_peripheral_by_normalized};

pub fn filter_characteristics_by_service<'a>(
    characteristics: &'a BTreeSet<Characteristic>,
    service_uuid: &str,
) -> Vec<&'a Characteristic> {
    // Try to normalize first (returns Option<String>)
    if let Some(norm_uuid_str) = normalize_uuid(service_uuid) {
        if let Ok(target_uuid) = Uuid::parse_str(&norm_uuid_str) {
            return characteristics
                .iter()
                .filter(|c| c.service_uuid == target_uuid)
                .collect();
        }
    }

    // If normalization or parsing fails, return empty vec
    Vec::new()
}
pub async fn handle(cmd: Value, adapter: &Adapter, out: &IpcWriter) -> Result<()> {
    let id = cmd.get("_id").cloned();
    let service = cmd.get("service").cloned().map(|v| match v {
        Value::String(s) => s.replace('{', "").replace('}', ""),
        other => other.to_string(),
    });
    let mut obj = make_response("characteristics", id.clone());

    if let Some(ref uuid) = service {

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

                if peripheral.services().is_empty() {
                    if let Err(e) = peripheral.discover_services().await {
                        obj["error"] = json!(format!("discover_services failed: {}", e));
                    }
                }


                if !peripheral.services().is_empty() {

                        let characteristics = peripheral.characteristics();
                        let filtered = filter_characteristics_by_service(&characteristics, &uuid);

                        let mut result = vec![];
                        for c in filtered {
                            let mut props = std::collections::BTreeMap::new();
                            props.insert("broadcast".to_string(), json!( c.properties.contains(CharPropFlags::BROADCAST)));
                            props.insert("read".to_string(), json!(c.properties.contains(CharPropFlags::READ)));
                            props.insert("writeWithoutResponse".to_string(), json!(c.properties.contains(CharPropFlags::WRITE_WITHOUT_RESPONSE)));
                            props.insert("write".to_string(), json!(c.properties.contains(CharPropFlags::WRITE)));
                            props.insert("notify".to_string(), json!(c.properties.contains(CharPropFlags::NOTIFY)));
                            props.insert("indicate".to_string(), json!(c.properties.contains(CharPropFlags::INDICATE)));
                            props.insert("authenticatedSignedWrites".to_string(), json!(c.properties.contains(CharPropFlags::AUTHENTICATED_SIGNED_WRITES)));

                            let obj = json!({
                                "uuid": c.uuid.to_string(),
                                "properties": props
                            });
                            result.push(obj);
                        }
                        
                        obj["result"] = json!(result);
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
