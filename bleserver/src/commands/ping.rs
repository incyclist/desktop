use anyhow::Result;
use serde_json::{json, Value};
use crate::ipc::{IpcWriter, send_event};

pub async fn handle(cmd: Value, out: &IpcWriter) -> Result<()> {
    let id = cmd.get("_id").cloned();
    let mut obj = json!({
        "_type": "response",
        "cmd": "pong"
    });
    if let Some(idv) = id { obj["_id"] = idv; }
    send_event(out, &obj).await
}
