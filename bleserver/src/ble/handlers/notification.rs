use crate::ipc::{IpcWriter, send_event};
use anyhow::Result;
use btleplug::api::ValueNotification;
use tokio::sync::mpsc::Receiver;

use serde_json::{json};

pub async fn handle_notification(sub_id: String, mut event_rx: Receiver<ValueNotification>, out: IpcWriter) -> Result<()> {

    // convert data into hex string
    let notification = event_rx.recv().await.unwrap();
    let uuid: String = notification.uuid.to_string();
    let hex_data = hex::encode(notification.value);   

    eprintln!("handle notification: {:#?}, {:#?}",uuid,hex_data);

    let evt = json!({
        "_type": "valueChangedNotification",
        "subscriptionId": sub_id,
        "value": hex_data
        
    });
    send_event(&out, &evt).await?;

     Ok(())
}
