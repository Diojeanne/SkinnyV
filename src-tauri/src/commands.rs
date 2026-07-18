use crate::audio::{AudioDeviceInfo, AudioEngine};
use crate::AppState;
use tauri::{Manager, WebviewWindowBuilder};

/// List all available audio capture sources.
///
/// On Windows these are output devices captured via WASAPI loopback; on
/// Linux/other they are input devices, preferring PipeWire/PulseAudio monitor
/// sources (which carry the system's playback).
#[tauri::command]
pub fn list_audio_devices() -> Vec<AudioDeviceInfo> {
    AudioEngine::list_devices()
}

/// Start capturing audio from a device (or default if None).
#[tauri::command]
pub fn start_capture(
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
    device_id: Option<String>,
) -> Result<(), String> {
    state.audio_engine.lock().start(device_id, app)
}

/// Stop audio capture.
#[tauri::command]
pub fn stop_capture(state: tauri::State<'_, AppState>) -> Result<(), String> {
    state.audio_engine.lock().stop();
    Ok(())
}

/// Check if capture is running and which device.
#[tauri::command]
pub fn get_capture_status(state: tauri::State<AppState>) -> CaptureStatus {
    let engine = state.audio_engine.lock();
    CaptureStatus {
        running: engine.is_running(),
        device: engine.current_device(),
    }
}

#[derive(serde::Serialize)]
pub struct CaptureStatus {
    pub running: bool,
    pub device: Option<String>,
}

/// Information about a connected monitor/display.
#[derive(serde::Serialize)]
pub struct MonitorInfo {
    pub name: String,
    pub id: u32,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub scale_factor: f32,
    pub is_primary: bool,
}

/// List all available monitors.
#[tauri::command]
pub fn list_monitors(app: tauri::AppHandle) -> Vec<MonitorInfo> {
    let available = app.available_monitors().unwrap_or_default();
    let primary = app.primary_monitor().ok().flatten();

    available
        .iter()
        .enumerate()
        .map(|(i, m)| {
            let pos = m.position();
            let size = m.size();
            let scale = m.scale_factor();
            let is_primary = primary
                .as_ref()
                .map(|p| p.position() == pos && p.size() == size)
                .unwrap_or(false);

            MonitorInfo {
                name: format!("Display {}", i + 1),
                id: i as u32,
                x: pos.x,
                y: pos.y,
                width: size.width,
                height: size.height,
                scale_factor: scale as f32,
                is_primary,
            }
        })
        .collect()
}

/// Open a borderless maximized visualizer window on a specific monitor.
#[tauri::command]
pub async fn open_visualizer_window(
    app: tauri::AppHandle,
    monitor_id: u32,
) -> Result<String, String> {
    let monitors = app
        .available_monitors()
        .map_err(|e| format!("Failed to list monitors: {}", e))?;
    let monitor = monitors
        .get(monitor_id as usize)
        .ok_or_else(|| format!("Monitor {} not found", monitor_id))?;

    let label = format!("visualizer-{}", monitor_id);
    let pos = monitor.position();
    let size = monitor.size();

    if app.get_webview_window(&label).is_some() {
        return Ok(label);
    }

    let _window = WebviewWindowBuilder::new(
        &app,
        &label,
        tauri::WebviewUrl::App("index.html".into()),
    )
    .title("SkinnyV Visualizer")
    .position(pos.x as f64, pos.y as f64)
    .inner_size(size.width as f64, size.height as f64)
    .fullscreen(true)
    .decorations(false)
    .always_on_top(false)
    .skip_taskbar(false)
    .build()
    .map_err(|e| format!("Failed to create window: {}", e))?;

    Ok(label)
}

/// Close a specific visualizer window.
#[tauri::command]
pub fn close_visualizer_window(
    app: tauri::AppHandle,
    monitor_id: u32,
) -> Result<(), String> {
    let label = format!("visualizer-{}", monitor_id);
    if let Some(window) = app.get_webview_window(&label) {
        window
            .close()
            .map_err(|e| format!("Failed to close window: {}", e))?;
    }
    Ok(())
}
