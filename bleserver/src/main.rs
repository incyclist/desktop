mod ipc;
mod ble;
mod commands;
mod utils;

use anyhow::Result;

#[tokio::main]
async fn main() -> Result<()> {
    let (mut ipc_reader, ipc_writer) = ipc::init().await?;


    // Initialize BLE adapter. The initial "Start" event will be emitted by the
    // state handler when the adapter reports `poweredOn` for the first time.
    let (adapter, event_rx) = ble::init().await?;

    // Note: don't attempt to query adapter state here (Adapter doesn't expose a
    // synchronous `state()` method). If the adapter is already powered on the
    // event loop will either receive a StateUpdate or we'll detect activity via
    // the first discovered device and trigger the state handler.

    // Spawn background BLE event handler
    tokio::spawn(ble::events::handle_events(adapter.clone(), event_rx, ipc_writer.clone()));

    // Command loop
    while let Some(cmd) = ipc_reader.recv().await {
        commands::handle(cmd, &adapter, &ipc_writer).await?;
    }

    Ok(())
}
