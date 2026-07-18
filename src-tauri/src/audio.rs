use crossbeam_channel::{unbounded, Sender};
use parking_lot::Mutex;

const FFT_SIZE: usize = 2048;
const NUM_BINS: usize = 128;
/// Assumed sample rate for frequency bin calculation. The Linux backend
/// hardcodes 48000 in its PulseAudio capture spec; PulseAudio resamples
/// transparently if the system rate differs. The Windows backend gets
/// the actual device rate from cpal but the FFT bin math assumes 48kHz
/// — the 20Hz lower bound shifts by <1 bin at 44.1kHz, negligible.
const SAMPLE_RATE: f32 = 48000.0;

/// Represents an audio source we can capture from.
#[derive(Clone, serde::Serialize)]
pub struct AudioDeviceInfo {
    pub name: String,
    pub id: String,
    pub is_default: bool,
}

/// What the frontend receives.
#[derive(Clone, serde::Serialize)]
pub struct FrequencyData {
    pub bins: Vec<f32>,
    pub volume: f32,
    pub peak: f32,
    pub beat: bool,
}

/// Commands sent to the audio thread.
enum AudioCommand {
    Start {
        device_id: Option<String>,
        result_tx: Sender<Result<(), String>>,
    },
    Stop,
}

/// AudioEngine is Send + Sync — it only owns channels, never a capture handle directly.
pub struct AudioEngine {
    cmd_tx: Mutex<Option<Sender<AudioCommand>>>,
    running: Mutex<bool>,
    current_device: Mutex<Option<String>>,
}

impl AudioEngine {
    pub fn new() -> Self {
        AudioEngine {
            cmd_tx: Mutex::new(None),
            running: Mutex::new(false),
            current_device: Mutex::new(None),
        }
    }

    pub fn list_devices() -> Vec<AudioDeviceInfo> {
        backend::list_devices()
    }

    pub fn start(
        &self,
        device_id: Option<String>,
        app_handle: tauri::AppHandle,
    ) -> Result<(), String> {
        self.stop();

        let (cmd_tx, cmd_rx) = unbounded::<AudioCommand>();

        std::thread::spawn(move || {
            audio_thread(cmd_rx, app_handle);
        });

        let (result_tx, _result_rx) = unbounded::<Result<(), String>>();

        *self.cmd_tx.lock() = Some(cmd_tx.clone());
        *self.current_device.lock() = device_id.clone();
        cmd_tx
            .send(AudioCommand::Start {
                device_id,
                result_tx: result_tx.clone(),
            })
            .ok();

        // Non-blocking: assume success. The audio thread reports errors to stderr.
        *self.running.lock() = true;
        Ok(())
    }

    pub fn stop(&self) {
        if let Some(tx) = self.cmd_tx.lock().take() {
            tx.send(AudioCommand::Stop).ok();
        }
        *self.running.lock() = false;
        *self.current_device.lock() = None;
    }

    pub fn is_running(&self) -> bool {
        *self.running.lock()
    }

    pub fn current_device(&self) -> Option<String> {
        self.current_device.lock().clone()
    }
}

/// Runs on a dedicated thread. Owns the platform capture handle (which may be
/// `!Send` on some platforms) and drives the Start/Stop command loop. Capture
/// itself is delegated to the platform `backend`; the DSP/emit pipeline below is
/// shared across every OS.
fn audio_thread(
    cmd_rx: crossbeam_channel::Receiver<AudioCommand>,
    app_handle: tauri::AppHandle,
) {
    println!("[SkinnyV] Audio thread started");

    let sample_tx = spawn_dsp_worker(app_handle);
    let mut active: Option<backend::CaptureHandle> = None;

    while let Ok(cmd) = cmd_rx.recv() {
        match cmd {
            AudioCommand::Start { device_id, result_tx } => {
                println!("[SkinnyV] Starting capture, source: {:?}", device_id);
                active.take(); // stop any previous capture
                match backend::open_capture(device_id, sample_tx.clone()) {
                    Ok(handle) => {
                        println!("[SkinnyV] Capture started");
                        active = Some(handle);
                        let _ = result_tx.send(Ok(()));
                    }
                    Err(msg) => {
                        println!("[SkinnyV] ERROR: {}", msg);
                        let _ = result_tx.send(Err(msg));
                    }
                }
            }
            AudioCommand::Stop => {
                println!("[SkinnyV] Stopping capture");
                active.take();
                break;
            }
        }
    }

    println!("[SkinnyV] Audio thread exiting");
}

/// Spawns the FFT + emit worker. Consumes interleaved-stereo `f32` sample chunks
/// on the returned channel and emits `audio-data` events to the frontend.
/// Platform-neutral: both capture backends feed the same channel.
fn spawn_dsp_worker(app_handle: tauri::AppHandle) -> Sender<Vec<f32>> {
    use realfft::RealFftPlanner;

    let (sample_tx, sample_rx) = unbounded::<Vec<f32>>();

    std::thread::spawn(move || {
        let mut fft_planner = RealFftPlanner::<f32>::new();
        let r2c = fft_planner.plan_fft_forward(FFT_SIZE);
        let mut spectrum = r2c.make_output_vec();
        let mut scratch = r2c.make_scratch_vec();

        let window: Vec<f32> = (0..FFT_SIZE)
            .map(|i| 0.5 - 0.5 * ((2.0 * std::f32::consts::PI * i as f32) / FFT_SIZE as f32).cos())
            .collect();

        let mut buffer: std::collections::VecDeque<f32> =
            std::collections::VecDeque::with_capacity(FFT_SIZE);
        let mut beat_history: std::collections::VecDeque<f32> =
            std::collections::VecDeque::with_capacity(43);
        let mut last_volume = 0.0f32;

        loop {
            match sample_rx.recv() {
                Ok(samples) => {
                    for chunk in samples.chunks(2) {
                        let mono = if chunk.len() == 2 {
                            (chunk[0] + chunk[1]) / 2.0
                        } else {
                            chunk[0]
                        };
                        buffer.push_back(mono);
                        if buffer.len() > FFT_SIZE {
                            buffer.pop_front();
                        }
                    }

                    if buffer.len() < FFT_SIZE {
                        continue;
                    }

                    let mut frame: Vec<f32> = buffer.iter().cloned().collect();
                    for (s, w) in frame.iter_mut().zip(window.iter()) {
                        *s *= w;
                    }

                    if r2c
                        .process_with_scratch(&mut frame, &mut spectrum, &mut scratch)
                        .is_err()
                    {
                        continue;
                    }

                    let bins = compute_bins(&spectrum, NUM_BINS);

                    let volume = bins.iter().sum::<f32>() / bins.len().max(1) as f32;
                    let peak = bins.iter().cloned().fold(0.0f32, f32::max);

                    beat_history.push_back(volume);
                    if beat_history.len() > 43 {
                        beat_history.pop_front();
                    }
                    let avg = beat_history.iter().sum::<f32>() / beat_history.len().max(1) as f32;
                    let beat =
                        volume > avg * 1.4 && volume > 0.01 && (volume - last_volume) > 0.005;
                    last_volume = volume;

                    let data = FrequencyData { bins, volume, peak, beat };

                    use tauri::Emitter;
                    let _ = app_handle.emit("audio-data", &data);
                }
                Err(_) => break,
            }
        }
    });

    sample_tx
}

/// Auto-gain state — rolling peak that decays slowly
use std::sync::atomic::{AtomicU32, Ordering};

static ROLLING_PEAK_BITS: AtomicU32 = AtomicU32::new(0); // stores f32 bits

fn load_peak() -> f32 {
    f32::from_bits(ROLLING_PEAK_BITS.load(Ordering::Relaxed))
}

fn store_peak(v: f32) {
    ROLLING_PEAK_BITS.store(v.to_bits(), Ordering::Relaxed);
}

/// Compute logarithmically-spaced frequency bins from FFT spectrum.
/// Uses auto-gain normalization with a decaying rolling peak.
fn compute_bins(
    spectrum: &[rustfft::num_complex::Complex<f32>],
    num_bins: usize,
) -> Vec<f32> {
    let n = spectrum.len();
    let usable = n / 2;

    let min_bin = (20.0 * n as f32 / SAMPLE_RATE).max(1.0) as usize;
    let max_bin = usable;

    let mut bins = Vec::with_capacity(num_bins);
    let mut frame_max = 0.0f32;

    for i in 0..num_bins {
        let t0 = i as f32 / num_bins as f32;
        let t1 = (i + 1) as f32 / num_bins as f32;

        let lo = (min_bin as f32 * (max_bin as f32 / min_bin as f32).powf(t0)) as usize;
        let hi = (min_bin as f32 * (max_bin as f32 / min_bin as f32).powf(t1)) as usize;

        let lo = lo.min(usable.saturating_sub(1));
        let hi = hi.max(lo + 1).min(usable);

        let mut sum = 0.0f32;
        let mut count = 0usize;
        for j in lo..hi {
            let mag = (spectrum[j].re * spectrum[j].re + spectrum[j].im * spectrum[j].im).sqrt();
            sum += mag;
            count += 1;
        }

        let avg = if count > 0 { sum / count as f32 } else { 0.0 };
        if avg > frame_max {
            frame_max = avg;
        }
        bins.push(avg);
    }

    let mut peak = load_peak();
    if frame_max > peak {
        peak = frame_max;
    } else {
        peak = peak * 0.98;
    }
    peak = peak.max(0.5);
    store_peak(peak);

    for b in bins.iter_mut() {
        *b = (*b / peak).min(1.0);
    }

    bins
}

// ===========================================================================
// Platform capture backends. Each exposes:
//   pub struct CaptureHandle;                         // stops capture on drop
//   pub fn list_devices() -> Vec<AudioDeviceInfo>;
//   pub fn open_capture(id, tx) -> Result<CaptureHandle, String>;
// and pushes interleaved-stereo f32 sample chunks into `tx`.
// ===========================================================================

/// Windows: WASAPI loopback — open an INPUT stream on an OUTPUT device.
#[cfg(target_os = "windows")]
mod backend {
    use super::AudioDeviceInfo;
    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
    use crossbeam_channel::Sender;

    pub struct CaptureHandle {
        _stream: cpal::Stream,
    }

    pub fn list_devices() -> Vec<AudioDeviceInfo> {
        let host = cpal::default_host();
        let mut devices = Vec::new();

        let default_name = host.default_output_device().and_then(|d| d.name().ok());

        if let Ok(output_devices) = host.output_devices() {
            for device in output_devices {
                let name = device.name().unwrap_or_else(|_| "Unknown".to_string());
                let is_default = default_name.as_deref() == Some(&name);
                devices.push(AudioDeviceInfo {
                    name: name.clone(),
                    id: name,
                    is_default,
                });
            }
        }
        devices
    }

    pub fn open_capture(
        device_id: Option<String>,
        tx: Sender<Vec<f32>>,
    ) -> Result<CaptureHandle, String> {
        use cpal::SampleFormat;

        let host = cpal::default_host();
        let device = match &device_id {
            Some(id) => host
                .output_devices()
                .map_err(|e| format!("Failed to enumerate output devices: {}", e))?
                .find(|d| d.name().map(|n| n == *id).unwrap_or(false)),
            None => host.default_output_device(),
        };
        let device = device.ok_or_else(|| "No output device found".to_string())?;

        let supported = device
            .default_output_config()
            .map_err(|e| format!("Failed to get output config: {}", e))?;
        let sample_format = supported.sample_format();
        let config: cpal::StreamConfig = supported.into();

        let err_fn = |err| eprintln!("[SkinnyV] Stream error: {}", err);
        let stream = match sample_format {
            SampleFormat::F32 => {
                let tx = tx.clone();
                device.build_input_stream(
                    &config,
                    move |data: &[f32], _: &_| {
                        let _ = tx.send(data.to_vec());
                    },
                    err_fn,
                    None,
                )
            }
            SampleFormat::I16 => {
                let tx = tx.clone();
                device.build_input_stream(
                    &config,
                    move |data: &[i16], _: &_| {
                        let converted: Vec<f32> =
                            data.iter().map(|&s| s as f32 / i16::MAX as f32).collect();
                        let _ = tx.send(converted);
                    },
                    err_fn,
                    None,
                )
            }
            SampleFormat::U16 => {
                let tx = tx.clone();
                device.build_input_stream(
                    &config,
                    move |data: &[u16], _: &_| {
                        let converted: Vec<f32> =
                            data.iter().map(|&s| (s as f32 - 32768.0) / 32768.0).collect();
                        let _ = tx.send(converted);
                    },
                    err_fn,
                    None,
                )
            }
            fmt => return Err(format!("Unsupported sample format: {:?}", fmt)),
        };

        let stream = stream.map_err(|e| format!("Failed to build input stream: {}", e))?;
        stream.play().map_err(|e| format!("Failed to play stream: {}", e))?;
        Ok(CaptureHandle { _stream: stream })
    }
}

/// Linux/other: capture from a PulseAudio/PipeWire monitor source.
#[cfg(not(target_os = "windows"))]
mod backend {
    use super::AudioDeviceInfo;
    use crossbeam_channel::Sender;
    use libpulse_binding as pulse;
    use libpulse_simple_binding::Simple;
    use pulse::callbacks::ListResult;
    use pulse::context::{Context, FlagSet as CtxFlags, State as CtxState};
    use pulse::mainloop::standard::{IterateResult, Mainloop};
    use pulse::operation::State as OpState;
    use pulse::sample::{Format, Spec};
    use pulse::stream::Direction;
    use std::cell::RefCell;
    use std::rc::Rc;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use std::thread::JoinHandle;

    pub struct CaptureHandle {
        stop: Arc<AtomicBool>,
        // The capture thread is detached, not joined. simple.read() is a
        // blocking call with no timeout — if the PulseAudio server stalls
        // or the monitor source disappears, joining would block forever.
        // The thread checks `stop` between reads and exits on its own
        // (normally within ~21ms). If it's stuck in read(), the OS
        // reaps it on process exit.
        _join: Option<JoinHandle<()>>,
    }

    impl Drop for CaptureHandle {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::Relaxed);
            // Deliberately do NOT join — see comment on _join field.
        }
    }

    struct SourceInfo {
        name: String,
        description: String,
        is_monitor: bool,
    }

    /// Connect to the pulse/pipewire server, run `f` against a ready context.
    fn with_context<T>(f: impl FnOnce(&mut Mainloop, &Context) -> Result<T, String>) -> Result<T, String> {
        let mut mainloop = Mainloop::new().ok_or("failed to create pulse mainloop")?;
        let mut context =
            Context::new(&mainloop, "SkinnyV").ok_or("failed to create pulse context")?;
        context
            .connect(None, CtxFlags::NOFLAGS, None)
            .map_err(|e| format!("pulse connect failed: {}", e))?;

        let result = (|| {
            loop {
                match mainloop.iterate(true) {
                    IterateResult::Success(_) => {}
                    IterateResult::Err(e) => return Err(format!("pulse mainloop error: {}", e)),
                    IterateResult::Quit(_) => return Err("pulse mainloop quit".into()),
                }
                match context.get_state() {
                    CtxState::Ready => break,
                    CtxState::Failed | CtxState::Terminated => {
                        return Err("pulse context failed".into())
                    }
                    _ => {}
                }
            }
            f(&mut mainloop, &context)
        })();

        // Clean up: explicitly disconnect the context so the PulseAudio
        // daemon releases the connection immediately. The mainloop and
        // context are freed when dropped, but disconnecting first avoids a
        // brief window where the daemon still considers us connected.
        let _ = context.disconnect();

        result
    }

    fn default_sink_name(mainloop: &mut Mainloop, context: &Context) -> Option<String> {
        let out = Rc::new(RefCell::new(None::<String>));
        let sink = out.clone();
        let op = context.introspect().get_server_info(move |info| {
            *sink.borrow_mut() = info.default_sink_name.as_ref().map(|s| s.to_string());
        });
        while op.get_state() == OpState::Running {
            if let IterateResult::Err(_) | IterateResult::Quit(_) = mainloop.iterate(true) {
                break;
            }
        }
        // Bind first so the borrow's temporary drops before `out`/`op` at block end.
        let name = out.borrow().clone();
        name
    }

    fn collect_sources(mainloop: &mut Mainloop, context: &Context) -> Vec<SourceInfo> {
        let out = Rc::new(RefCell::new(Vec::<SourceInfo>::new()));
        let sink = out.clone();
        let op = context.introspect().get_source_info_list(move |res| {
            if let ListResult::Item(item) = res {
                sink.borrow_mut().push(SourceInfo {
                    name: item.name.as_ref().map(|s| s.to_string()).unwrap_or_default(),
                    description: item
                        .description
                        .as_ref()
                        .map(|s| s.to_string())
                        .unwrap_or_default(),
                    is_monitor: item.monitor_of_sink.is_some(),
                });
            }
        });
        while op.get_state() == OpState::Running {
            if let IterateResult::Err(_) | IterateResult::Quit(_) = mainloop.iterate(true) {
                break;
            }
        }
        // `op` still holds a clone of the callback (and thus of `out`), so move
        // the collected vec out rather than trying to unwrap the Rc. Bind first so
        // the borrow's temporary drops before `out`/`op` at block end.
        let collected = std::mem::take(&mut *out.borrow_mut());
        collected
    }

    pub fn list_devices() -> Vec<AudioDeviceInfo> {
        with_context(|mainloop, context| {
            let default_monitor =
                default_sink_name(mainloop, context).map(|s| format!("{}.monitor", s));

            // Offer system-audio sources only — i.e. monitor sources — mirroring the
            // Windows backend, which lists output devices rather than inputs. Mics
            // are deliberately excluded, so capture can never silently fall back to
            // one. If no monitor exists the list is empty: the UI shows "no devices"
            // and an explicit start attempt errors rather than grabbing an input.
            let monitors: Vec<_> = collect_sources(mainloop, context)
                .into_iter()
                .filter(|s| s.is_monitor)
                .collect();

            // Default to the active sink's monitor, else the first available monitor.
            let default_id = default_monitor
                .filter(|m| monitors.iter().any(|s| &s.name == m))
                .or_else(|| monitors.first().map(|s| s.name.clone()));

            let devices = monitors
                .into_iter()
                .map(|s| {
                    let is_default = Some(&s.name) == default_id.as_ref();
                    let label = if s.description.is_empty() {
                        s.name.clone()
                    } else {
                        s.description.clone()
                    };
                    AudioDeviceInfo { name: label, id: s.name, is_default }
                })
                .collect();
            Ok(devices)
        })
        .unwrap_or_default()
    }

    fn resolve_target(device_id: Option<String>) -> Result<String, String> {
        if let Some(id) = device_id {
            return Ok(id);
        }
        with_context(|mainloop, context| {
            let sources = collect_sources(mainloop, context);

            if let Some(sink) = default_sink_name(mainloop, context) {
                let monitor = format!("{}.monitor", sink);
                if sources.iter().any(|s| s.name == monitor) {
                    return Ok(monitor);
                }
            }

            // No default sink match — fall back to first available monitor.
            sources
                .into_iter()
                .find(|s| s.is_monitor)
                .map(|s| s.name)
                .ok_or_else(|| "no monitor source found".to_string())
        })
    }

    pub fn open_capture(
        device_id: Option<String>,
        tx: Sender<Vec<f32>>,
    ) -> Result<CaptureHandle, String> {
        let target = resolve_target(device_id)?;
        println!("[SkinnyV] Capturing from source: {}", target);

        let spec = Spec { format: Format::F32le, channels: 2, rate: 48000 };
        if !spec.is_valid() {
            return Err("invalid pulse sample spec".into());
        }

        let simple = Simple::new(
            None,
            "SkinnyV",
            Direction::Record,
            Some(&target),
            "system audio",
            &spec,
            None,
            None,
        )
        .map_err(|e| format!("failed to open capture stream: {}", e))?;

        let stop = Arc::new(AtomicBool::new(false));
        let stop_thread = stop.clone();
        let join = std::thread::spawn(move || {
            // 1024 stereo f32 frames per read (~21ms at 48kHz).
            let mut bytes = [0u8; 1024 * 2 * 4];
            while !stop_thread.load(Ordering::Relaxed) {
                if simple.read(&mut bytes).is_err() {
                    break;
                }
                let samples: Vec<f32> = bytes
                    .chunks_exact(4)
                    .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
                    .collect();
                if tx.send(samples).is_err() {
                    break;
                }
            }
        });

        Ok(CaptureHandle { stop, _join: Some(join) })
    }
}