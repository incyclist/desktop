use anyhow::Result;
use serde_json::Value;
use tokio::{
    io::{self, AsyncReadExt, AsyncWriteExt},
    sync::mpsc,
};

/// Wrapper around mpsc::Receiver for reading JSON messages
pub struct IpcReader(pub mpsc::Receiver<Value>);

impl IpcReader {
    pub async fn recv(&mut self) -> Option<Value> {
        self.0.recv().await
    }
}

pub type IpcWriter = mpsc::Sender<Value>;

/// Initializes IPC over stdin/stdout with Int32LE length framing
pub async fn init() -> Result<(IpcReader, IpcWriter)> {
    let (tx_out, mut rx_out) = mpsc::channel::<Value>(64);
    let (tx_in, rx_in) = mpsc::channel::<Value>(64);

    // Reader task: reads length-prefixed JSON from stdin
    tokio::spawn(async move {
        let mut stdin = io::stdin();
        loop {
            let mut len_buf = [0u8; 4];
            if stdin.read_exact(&mut len_buf).await.is_err() {
                break;
            }
            let len = i32::from_le_bytes(len_buf) as usize;
            let mut data = vec![0u8; len];
            if stdin.read_exact(&mut data).await.is_err() {
                break;
            }
            if let Ok(json) = serde_json::from_slice(&data) {
                let _ = tx_in.send(json).await;
            }
        }
    });

    // Writer task: writes length-prefixed JSON to stdout. Be defensive about
    // serialization and write errors so the task doesn't panic and bring down
    // the whole process when IPC clients misbehave or partial writes occur.
    tokio::spawn(async move {
        let mut stdout = io::stdout();
        while let Some(value) = rx_out.recv().await {
            match serde_json::to_vec(&value) {
                Ok(data) => {
                    let mut len = Vec::new();
                    if let Err(e) = byteorder::WriteBytesExt::write_i32::<byteorder::LittleEndian>(&mut len, data.len() as i32) {
                        // Log to stderr and skip this message
                        let _ = eprintln!("failed to write length prefix: {}", e);
                        continue;
                    }

                    if stdout.write_all(&len).await.is_err() {
                        let _ = eprintln!("failed to write length prefix to stdout");
                        break;
                    }
                    if stdout.write_all(&data).await.is_err() {
                        let _ = eprintln!("failed to write data to stdout");
                        break;
                    }
                    if stdout.flush().await.is_err() {
                        let _ = eprintln!("failed to flush stdout");
                        break;
                    }
                }
                Err(e) => {
                    let _ = eprintln!("failed to serialize JSON for IPC: {}", e);
                    // skip this message but keep the writer running
                    continue;
                }
            }
        }
    });

    Ok((IpcReader(rx_in), tx_out))
}

/// Sends a JSON event to the IPC writer
pub async fn send_event(tx: &IpcWriter, value: &Value) -> Result<()> {
    tx.send(value.clone()).await?;
    Ok(())
}
