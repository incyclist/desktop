mod ping;
mod scan;
mod connect;
mod disconnect;
mod services;
mod characteristics;
mod subscribe;

use anyhow::Result;
use serde_json::{Value,json};

use btleplug::platform::Adapter;
use btleplug::platform::Peripheral as PlatformPeripheral;
use btleplug::api::Peripheral as _;
use btleplug::api::{Central};

use crate::ipc::IpcWriter;
use crate::utils::{normalize_bluetooth_address, format_bluetooth_address};


pub async fn find_peripheral_by_normalized(
    adapter: &Adapter,
    norm: &str,
) -> Result<Option<(PlatformPeripheral, String)>, anyhow::Error> {
    let peripherals = adapter.peripherals().await?;
    for p in peripherals {
        if let Ok(props) = p.properties().await {
            if let Some(props) = props {
                let formatted = format_bluetooth_address(&props.address);
                if formatted == norm {
                    return Ok(Some((p, formatted)));
                }
            }
        }
    }
    Ok(None)
}

pub fn make_response(cmd: &str, id: Option<serde_json::Value>) -> serde_json::Value {
    let mut obj = json!({
        "_type": "response",
        "cmd": cmd,
        "result": null
    });
    if let Some(idv) = id { obj["_id"] = idv; }
    obj
}

pub fn extract_normalized_address(cmd: &Value) -> Result<String, String> {
    // If the command already provides a `device` field containing a normalized
    // address, prefer that (but validate it via normalize_bluetooth_address).
    if let Some(dev) = cmd.get("device").and_then(|d| d.as_str()) {
        if let Some(norm) = normalize_bluetooth_address(dev) {
            return Ok(norm);
        }
    }

    // Fallback: accept either `address` or `addr` as before.
    let address = cmd
        .get("address")
        .or_else(|| cmd.get("addr"))
        .and_then(|a| a.as_str())
        .map(|s| s.to_string());

    let address = address.ok_or_else(|| "missing address".to_string())?;

    normalize_bluetooth_address(&address).ok_or_else(|| "invalid address format".to_string())
}


pub async fn handle(cmd: Value, adapter: &Adapter, out: &IpcWriter) -> Result<()> {
    let Some(command) = cmd.get("cmd").and_then(|c| c.as_str()) else {
        return Ok(());
    };

    match command {
        "ping" => ping::handle(cmd, out).await?,
        "scan" | "stopScan" => scan::handle(cmd, adapter, out).await?,
        "connect"  => connect::handle(cmd, adapter, out).await?,
        "disconnect"   => disconnect::handle(cmd, adapter, out).await?,
        "services" => services::handle(cmd, adapter, out).await?,
        "characteristics" => characteristics::handle(cmd, adapter, out).await?,
        "subscribe" => subscribe::handle(cmd, adapter, out).await?,
        _ => {
            let err = serde_json::json!({
                "_type": "error",
                "message": format!("Unknown command: {}", command)
            });
            crate::ipc::send_event(out, &err).await?;
        }
    }

    Ok(())
}
