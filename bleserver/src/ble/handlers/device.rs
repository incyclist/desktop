use anyhow::Result;
use btleplug::api::PeripheralProperties;
use serde_json::{Value, Map, json};
use std::time::SystemTime;
use crate::ipc::{IpcWriter, send_event};
use crate::utils::{filetime_timestamp, format_bluetooth_address};
use hex;

pub async fn handle_discovered_props(props: PeripheralProperties, out: &IpcWriter) -> Result<()> {
    let mut evt = Map::new();

    evt.insert("_type".to_string(), Value::String("scanResult".to_string()));
    evt.insert("bluetoothAddress".to_string(), Value::String(format_bluetooth_address(&props.address)));
    evt.insert("rssi".to_string(), Value::Number(props.rssi.unwrap_or(0).into()));
    // PeripheralProperties does not expose timestamp on all platforms; use None for now
    evt.insert("timestamp".to_string(), Value::from(filetime_timestamp(Some(SystemTime::now()))));
    evt.insert("advType".to_string(), Value::String("ScanResponse".to_string()));

    let service_uuids: Vec<Value> = props
        .services
        .iter()
        .map(|uuid| Value::String(uuid.to_string()))
        .collect();

    evt.insert("serviceUuids".to_string(), Value::Array(service_uuids));

    if let Some(name) = &props.local_name {
        evt.insert("localName".to_string(), Value::String(name.clone()));
    }

    if let Some(tx) = props.tx_power_level {
        evt.insert("txPower".to_string(), Value::from(tx));
    }

    // service_data -> map of uuid => hex
    let service_data: Map<String, Value> = props
        .service_data
        .iter()
        .map(|(uuid, data)| (uuid.to_string(), Value::String(hex::encode(data))))
        .collect();
    evt.insert("serviceData".to_string(), Value::Object(service_data));

    let scan_result = Value::Object(evt);
    send_event(out, &scan_result).await?;
    Ok(())
}



pub async fn handle_disconnected(address: String, out: &IpcWriter) -> Result<()> {
    let evt = json!({
        "_type": "disconnectEvent",
        "device": address,
        "address": address
    });
    send_event(out, &evt).await?;
    Ok(())
}


