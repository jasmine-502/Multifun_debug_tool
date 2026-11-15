use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use serialport::SerialPortType;
use serde::Serialize;
use tauri::{AppHandle, Emitter};

#[derive(Debug, Clone, Serialize)]
pub struct PortInfo {
    pub port: String,
    pub description: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vid: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pid: Option<u16>,
    /// Espressif 原生 USB-Serial-JTAG：碰控制线会被当成 download 请求，不能复位
    pub jtag: bool,
}

const ESPRESSIF_VID: u16 = 0x303A;

/// 端口是否是 Espressif 芯片原生 USB（USB-Serial-JTAG）：
/// 这类口在芯片复位后会重新枚举，旧句柄会失效。
pub fn is_native_usb(port_name: &str) -> bool {
    serialport::available_ports()
        .unwrap_or_default()
        .into_iter()
        .any(|info| {
            info.port_name == port_name
                && matches!(&info.port_type, SerialPortType::UsbPort(usb) if usb.vid == ESPRESSIF_VID)
        })
}

/// 枚举串口：过滤黑名单，并按 COM 号降序（新插入设备通常号更大）
pub fn collect(blacklist: &[String]) -> Vec<PortInfo> {
    let mut items: Vec<(u32, PortInfo)> = serialport::available_ports()
        .unwrap_or_default()
        .into_iter()
        .filter(|info| !blacklist.iter().any(|blocked| blocked == &info.port_name))
        .map(|info| {
            let (description, vid, pid, jtag) = match &info.port_type {
                SerialPortType::UsbPort(usb) => {
                    let base = usb
                        .product
                        .clone()
                        .or_else(|| usb.manufacturer.clone())
                        .unwrap_or_else(|| "USB 串口".to_string());
                    let jtag = usb.vid == ESPRESSIF_VID;
                    if jtag {
                        (format!("{base}（芯片原生 USB，非 UART 桥）"), Some(usb.vid), Some(usb.pid), true)
                    } else {
                        (base, Some(usb.vid), Some(usb.pid), false)
                    }
                }
                SerialPortType::PciPort => ("PCI 串口".to_string(), None, None, false),
                SerialPortType::BluetoothPort => ("蓝牙串口".to_string(), None, None, false),
                SerialPortType::Unknown => (String::new(), None, None, false),
            };
            let order = info
                .port_name
                .trim_start_matches("COM")
                .parse::<u32>()
                .unwrap_or(0);
            (
                order,
                PortInfo {
                    port: info.port_name,
                    description,
                    vid,
                    pid,
                    jtag,
                },
            )
        })
        .collect();

    items.sort_by(|left, right| right.0.cmp(&left.0));
    items.into_iter().map(|(_, info)| info).collect()
}

/// 热插拔监测：500ms 轮询一次，仅在列表变化时推送，与 Qt 版刷新节奏一致
pub fn spawn_monitor(app: AppHandle, blacklist: Arc<Mutex<Vec<String>>>) {
    std::thread::spawn(move || {
        let mut last = String::new();
        loop {
            let blocked = blacklist.lock().clone();
            let ports = collect(&blocked);
            let key = serde_json::to_string(&ports).unwrap_or_default();
            if key != last {
                last = key;
                let _ = app.emit("esp://ports", &ports);
            }
            std::thread::sleep(Duration::from_millis(500));
        }
    });
}
