use std::time::{SystemTime, UNIX_EPOCH, Duration};

pub fn filetime_timestamp(ts: Option<SystemTime>) -> f64 {
    if let Some(st) = ts {
        let duration = st.duration_since(UNIX_EPOCH).unwrap_or(Duration::ZERO);
        let unix_ms = duration.as_millis() as f64;
        unix_ms + 11644473600000.0  // Windows FILETIME offset
    } else {
        0.0
    }
}

pub fn format_bluetooth_address(addr: &btleplug::api::BDAddr) -> String {
    addr.to_string().to_lowercase() // btleplug formats as XX:XX:XX:XX:XX:XX
}


/// Normalize a Bluetooth address string into the colon-separated lowercase form
/// "xx:xx:xx:xx:xx:xx". Accepts either "xxxxxxxxxxxx" or "xx:xx:xx:xx:xx:xx".
pub fn normalize_bluetooth_address(s: &str) -> Option<String> {
    let hex: String = s.chars().filter(|c| c.is_ascii_hexdigit()).collect();
    if hex.len() != 12 {
        return None;
    }
    let mut parts = Vec::with_capacity(6);
    for i in 0..6 {
        parts.push(hex[2 * i..2 * i + 2].to_lowercase());
    }
    Some(parts.join(":"))
}

use regex::Regex;

/// Normalizes a UUID string to the format:
/// - full UUIDs like `a026ee0b-0a7d-4ab3-97fa-f1500f9feb8b`
/// - or short UUIDs like `1801`, `00001801`, `0x1801`, `0x00001801`
///
/// Output is always lowercase, with dashes in standard UUID positions.
/// Examples:
/// - "A026EE0B0A7D4AB397FAF1500F9FEB8B" → "a026ee0b-0a7d-4ab3-97fa-f1500f9feb8b"
/// - "1801" → "00001801-0000-1000-8000-00805f9b34fb"
/// - "0x1801" → "00001801-0000-1000-8000-00805f9b34fb"
pub fn normalize_uuid(s: &str) -> Option<String> {
    let s = s.trim().to_lowercase();

    // Remove "0x" prefix if present
    let s = s.strip_prefix("0x").unwrap_or(&s);

    // Handle 4-digit short UUIDs (e.g. 1801)
    if s.len() == 4 && s.chars().all(|c| c.is_ascii_hexdigit()) {
        return Some(format!("0000{}-0000-1000-8000-00805f9b34fb", s));
    }

    // Handle 8-digit short UUIDs (e.g. 00001801)
    if s.len() == 8 && s.chars().all(|c| c.is_ascii_hexdigit()) {
        return Some(format!("{}-0000-1000-8000-00805f9b34fb", s));
    }

    // Handle UUIDs without dashes (32 hex characters)
    if s.len() == 32 && s.chars().all(|c| c.is_ascii_hexdigit()) {
        return Some(format!(
            "{}-{}-{}-{}-{}",
            &s[0..8],
            &s[8..12],
            &s[12..16],
            &s[16..20],
            &s[20..32]
        ));
    }

    // Handle already well-formed UUIDs
    let uuid_re =
        Regex::new(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$").unwrap();
    if uuid_re.is_match(&s) {
        return Some(s.to_string());
    }

    None
}
