use anyhow::Result;
use btleplug::api::Peripheral;
use serde_json::json;
use serde_json::Value;
use btleplug::platform::Adapter;
use btleplug::api::Characteristic;
use crate::ipc::{IpcWriter, send_event};
use super::{make_response, extract_normalized_address,find_peripheral_by_normalized};
use futures_util::StreamExt;
use std::collections::HashMap;
use std::sync::Mutex;
use std::sync::MutexGuard;
use std::sync::OnceLock;
use tokio::task::JoinHandle;

fn get_uuid(cmd: &Value, key: &str) -> Option<String> {
    let service = cmd.get(key).cloned().map(|v| match v {
        Value::String(s) => s.replace('{', "").replace('}', ""),
        other => other.to_string(),
    });
    service
}

fn get_subs() -> MutexGuard<'static, HashMap<String, JoinHandle<()>>> {
    static DB: OnceLock<Mutex<HashMap<String, JoinHandle<()>>>> = OnceLock::new();
    DB.get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .expect("Let's hope the lock isn't poisoned")
}

pub fn cleanup( address: String) {

    // get all records from DB where the key starts with the address and abort the processing thread

    let subs = get_subs();
    
    for k in subs.keys() {
        if k.starts_with(&address) {
            let sub_id = k.to_string();
            if let Some(handle) = get_subs().remove(&sub_id) {
                handle.abort();
            }
        }
    }
}

pub async fn handle(cmd: Value, adapter: &Adapter, out: &IpcWriter) -> Result<()> {
    let id = cmd.get("_id").cloned();
    
    let service_uuid = get_uuid(&cmd, "service");
    let characteristic_uuid = get_uuid(&cmd, "characteristic");
    let mut task= "";
    let command = cmd.get("cmd").and_then(|c| c.as_str()) ;

    match command {
        Some("subscribe") => {
            task = "subscribe";
        }
        Some("unsubscribe") => {
        }
        _ => {
            let err = serde_json::json!({
                "_type": "error",
                "message": format!("Unknown command: {:?}", command)
            });
            crate::ipc::send_event(out, &err).await?;
        }
    }


    let mut obj = make_response(&task, id.clone());

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
                    let target_uuid = target.uuid.to_string();
                    
                    // handle the case that subscribe fails
                    if task == "subscribe" {
                        if let Err(e) = peripheral.subscribe(&target).await {
                            obj["error"] = json!(format!("subscribe failed: {}", e));
                            send_event(out, &obj).await?;
                            return Ok(());
                        }
                    }
                    else {
                        if let Err(e) = peripheral.unsubscribe(&target).await {
                            obj["error"] = json!(format!("unsubscribe failed: {}", e));
                            send_event(out, &obj).await?;
                            return Ok(());
                        }

                    }

                    // build a unique Id for this subscription based on the address, service uuid and characteristic uuid
                    let subscription_id = format!("{}:{}:{}", peripheral.address(), target.service_uuid, target.uuid);
                    let sub_id:String = subscription_id.clone();
                    obj["result"] = json!(subscription_id);


                    // If task = "subscribe" I will create a new thread to handle notifications. 
                    // If task = "unsubscribe" I want to abort that threat
                    // use a global variable to store the information about threads and sub_ids


                    if task == "subscribe" {

                        if get_subs().is_empty() {
                            let mut notification_stream  = peripheral.notifications().await?;                        
                            //let (tx, rx) = mpsc::channel(64);                        
                            let oc = out.clone();

                            let h = tokio::spawn(async move {
                                while let Some(e) = notification_stream.next().await {



                                    let notification = e.clone();
                                    let uuid: String = notification.uuid.to_string();
                                    let hex_data = hex::encode(notification.value);   

                                    eprintln!("handle notification: {:#?}: {:#?}",uuid, hex_data.clone());
                                    if notification.uuid.to_string() != target_uuid {
                                        continue
                                    }


                                    

                                    let evt = json!({
                                        "_type": "valueChangedNotification",
                                        "subscriptionId": sub_id,
                                        "value": hex_data,
                                        
                                    });
                                    send_event(&oc, &evt).await.unwrap();
                                    
                                }
                            });
                            get_subs().insert(subscription_id, h);

                        }


                        
                    }
                    else {

                        if let Some(handle) = get_subs().remove(&subscription_id) {

                            handle.abort();
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

