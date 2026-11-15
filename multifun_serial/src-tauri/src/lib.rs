mod commands;
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
        ])
        .setup(|app| {
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
