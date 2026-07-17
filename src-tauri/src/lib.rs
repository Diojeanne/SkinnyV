mod audio;
mod commands;

use audio::AudioEngine;
use parking_lot::Mutex;
use std::sync::Arc;
use tauri::Manager;

pub struct AppState {
    pub audio_engine: Arc<Mutex<AudioEngine>>,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let audio_engine = AudioEngine::new();
            let state = AppState {
                audio_engine: Arc::new(Mutex::new(audio_engine)),
            };
            app.manage(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_audio_devices,
            commands::start_capture,
            commands::stop_capture,
            commands::get_capture_status,
            commands::list_monitors,
            commands::open_visualizer_window,
            commands::close_visualizer_window,
        ])
        .run(tauri::generate_context!())
        .expect("error while running SkinnyV");
}
