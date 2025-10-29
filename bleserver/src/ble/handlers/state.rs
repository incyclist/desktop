use anyhow::Result;
use crate::ipc::{IpcWriter, send_event};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

// Remember the last adapter state we saw so we only emit AdapterState when it changes.
static LAST_STATE: Mutex<Option<String>> = Mutex::new(None);
static START_SENT: AtomicBool = AtomicBool::new(false);

/// Handle central state updates. This is a stub for now and will be expanded
/// to emit IPC messages about the adapter state (powered on/off, etc.).
///
/// Additionally, send the initial "Start" event once when the adapter
/// becomes powered on for the first time after launch.

pub async fn handle_state_update(state: &str, out: &IpcWriter) -> Result<()> {
    // Only emit AdapterState when the state actually changes.
    // Be defensive: if the mutex is poisoned for any reason, recover the inner
    // value rather than panicking. Using `unwrap_or_else(|e| e.into_inner())`
    // prevents a poisoned-lock panic which was observed when concurrent
    // operations raced and caused an unwind elsewhere.
    let changed = {
        let mut last = LAST_STATE.lock().unwrap_or_else(|e| e.into_inner());
        let changed = match &*last {
            Some(prev) => prev != state,
            None => true,
        };
        if changed {
            *last = Some(state.to_string());
        }
        changed
    };

    if changed {
        let event = serde_json::json!({"event": "AdapterState", "state": state});
        send_event(out, &event).await?;
    }

    // If this is the first poweredOn we see, send the Start event once.
    if state == "poweredOn" {
        // attempt to set START_SENT from false -> true; if successful, send Start
        if START_SENT
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
        {
            let start_evt = serde_json::json!({
                "_type": "Start",
                "message": "BLE adapter initialized and ready"
            });
            send_event(out, &start_evt).await?;
        }
    }

    Ok(())
}
