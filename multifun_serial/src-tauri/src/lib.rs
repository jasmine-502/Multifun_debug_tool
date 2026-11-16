mod commands;
mod esp_flash;
mod firmware_merge;
mod log_parser;
mod ports;
mod serial_reader;
mod state;

use std::sync::Arc;

use tauri::Manager;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(state::AppState::default())
        .invoke_handler(tauri::generate_handler![
            commands::list_ports,
            commands::open_log,
            commands::close_log,
            commands::set_filters,
            commands::set_autosave,
            commands::set_autosave_format,
            commands::save_snapshot,
            commands::save_raw_snapshot,
            commands::open_log_dir,
            commands::default_log_dir,
            commands::scan_firmware,
            commands::merge_firmware,
            commands::esp_flash,
            commands::esp_erase,
            commands::esp_detect,
        ])
        .setup(|app| {
            // 窗口标题补上版本号：截图反馈时不用再问「你跑的哪一版」。
            // 版本号取 package_info()，它由 tauri.conf.json 的 version 生成，
            // 和 MSI 的 ProductVersion、侧栏显示是同一个真相源
            if let Some(window) = app.get_webview_window("main") {
                if let Ok(title) = window.title() {
                    let _ = window.set_title(&format!("{title} v{}", app.package_info().version));
                }
            }
            // espflash 的握手/复位细节走 log，接到烧录页日志里
            esp_flash::install_logger(app.handle().clone());
            let state = app.state::<state::AppState>();
            ports::spawn_monitor(app.handle().clone(), Arc::clone(&state.blacklist));
            Ok(())
        })
        .on_window_event(|window, event| {
            // 关窗时优雅收尾：停读线程 + 关闭日志文件（写入结束时间）
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                let state = window.state::<state::AppState>();
                commands::stop_session(&state);
            }
        })
        .run(tauri::generate_context!())
        .expect("Multifun Serial 启动失败");
}
