use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use crossbeam_channel::{unbounded, Sender};
use parking_lot::Mutex;

const FFT_SIZE: usize = 2048;
const NUM_BINS: usize = 128;

/// Represents an audio device we can capture from.
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

/// AudioEngine is Send + Sync — it only owns channels, never the stream directly.
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
        let host = cpal::default_host();
        let mut devices = Vec::new();

        let default_name = host
            .default_output_device()
            .and_then(|d| d.name().ok());

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

        // Non-blocking: assume success. The audio thread will print errors to stderr.
        // We set running=true optimistically; stop_capture checks cmd_tx anyway.
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

/// Runs on a dedicated thread. Owns the cpal::Stream (which is !Send on some platforms).
fn audio_thread(
    cmd_rx: crossbeam_channel::Receiver<AudioCommand>,
    app_handle: tauri::AppHandle,
) {
    use cpal::SampleFormat;
    use realfft::RealFftPlanner;

    println!("[SkinnyV] Audio thread started");

    let mut active_stream: Option<cpal::Stream> = None;

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

    let (sample_tx, sample_rx) = unbounded::<Vec<f32>>();

    // Spawn FFT+emit worker
    let emit_handle = app_handle.clone();
    std::thread::spawn(move || {
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
                    let avg =
                        beat_history.iter().sum::<f32>() / beat_history.len().max(1) as f32;
                    let beat =
                        volume > avg * 1.4 && volume > 0.01 && (volume - last_volume) > 0.005;
                    last_volume = volume;

                    let data = FrequencyData { bins, volume, peak, beat };

                    use tauri::Emitter;
                    let _ = emit_handle.emit("audio-data", &data);
                }
                Err(_) => break,
            }
        }
    });

    // Process commands
    while let Ok(cmd) = cmd_rx.recv() {
        match cmd {
            AudioCommand::Start { device_id, result_tx } => {
                println!("[SkinnyV] Starting capture, device: {:?}", device_id);

                // Drop old stream
                active_stream.take();

                let host = cpal::default_host();
                let device = match &device_id {
                    Some(id) => {
                        println!("[SkinnyV] Looking for device: {}", id);
                        match host.output_devices() {
                            Ok(mut devs) => devs.find(|d| {
                                d.name().map(|n| {
                                    println!("[SkinnyV] Found device: {}", n);
                                    n == *id
                                }).unwrap_or(false)
                            }),
                            Err(e) => {
                                let msg = format!("Failed to enumerate output devices: {}", e);
                                println!("[SkinnyV] ERROR: {}", msg);
                                let _ = result_tx.send(Err(msg));
                                continue;
                            }
                        }
                    }
                    None => {
                        println!("[SkinnyV] Using default output device");
                        host.default_output_device()
                    }
                };

                let device = match device {
                    Some(d) => d,
                    None => {
                        let msg = "No output device found".to_string();
                        println!("[SkinnyV] ERROR: {}", msg);
                        let _ = result_tx.send(Err(msg));
                        continue;
                    }
                };

                let supported = match device.default_output_config() {
                    Ok(c) => {
                        println!("[SkinnyV] Device config: {:?}, sample format: {:?}", c.channels(), c.sample_format());
                        c
                    }
                    Err(e) => {
                        let msg = format!("Failed to get output config: {}", e);
                        println!("[SkinnyV] ERROR: {}", msg);
                        let _ = result_tx.send(Err(msg));
                        continue;
                    }
                };

                let sample_format = supported.sample_format();
                let config: cpal::StreamConfig = supported.into();

                println!("[SkinnyV] Building input stream (loopback) with format {:?}", sample_format);

                let tx = sample_tx.clone();
                let stream = match sample_format {
                    SampleFormat::F32 => device.build_input_stream(
                        &config,
                        move |data: &[f32], _: &_| { let _ = tx.send(data.to_vec()); },
                        |err| eprintln!("[SkinnyV] Stream error: {}", err),
                        None,
                    ),
                    SampleFormat::I16 => {
                        let tx = sample_tx.clone();
                        device.build_input_stream(
                            &config,
                            move |data: &[i16], _: &_| {
                                let converted: Vec<f32> = data.iter().map(|&s| s as f32 / i16::MAX as f32).collect();
                                let _ = tx.send(converted);
                            },
                            |err| eprintln!("[SkinnyV] Stream error: {}", err),
                            None,
                        )
                    }
                    SampleFormat::U16 => {
                        let tx = sample_tx.clone();
                        device.build_input_stream(
                            &config,
                            move |data: &[u16], _: &_| {
                                let converted: Vec<f32> = data.iter().map(|&s| (s as f32 - 32768.0) / 32768.0).collect();
                                let _ = tx.send(converted);
                            },
                            |err| eprintln!("[SkinnyV] Stream error: {}", err),
                            None,
                        )
                    }
                    fmt => {
                        let msg = format!("Unsupported sample format: {:?}", fmt);
                        println!("[SkinnyV] ERROR: {}", msg);
                        let _ = result_tx.send(Err(msg));
                        continue;
                    }
                };

                match stream {
                    Ok(s) => {
                        println!("[SkinnyV] Stream built successfully, playing...");
                        match s.play() {
                            Ok(_) => {
                                println!("[SkinnyV] Stream playing!");
                                active_stream = Some(s);
                                let _ = result_tx.send(Ok(()));
                            }
                            Err(e) => {
                                let msg = format!("Failed to play stream: {}", e);
                                println!("[SkinnyV] ERROR: {}", msg);
                                let _ = result_tx.send(Err(msg));
                            }
                        }
                    }
                    Err(e) => {
                        let msg = format!("Failed to build input stream: {}", e);
                        println!("[SkinnyV] ERROR: {}", msg);
                        let _ = result_tx.send(Err(msg));
                    }
                }
            }
            AudioCommand::Stop => {
                println!("[SkinnyV] Stopping capture");
                active_stream.take();
                break;
            }
        }
    }

    println!("[SkinnyV] Audio thread exiting");
}

/// Compute logarithmically-spaced frequency bins from FFT spectrum.
fn compute_bins(
    spectrum: &[rustfft::num_complex::Complex<f32>],
    num_bins: usize,
) -> Vec<f32> {
    let n = spectrum.len();
    let usable = n / 2;

    // Use a reasonable sample rate for bin calculation (48kHz typical)
    let sample_rate = 48000.0f32;
    let min_bin = (20.0 * n as f32 / sample_rate).max(1.0) as usize;
    let max_bin = usable;

    let mut bins = Vec::with_capacity(num_bins);
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
        let normalized = (avg / (FFT_SIZE as f32 / 2.0)).min(1.0);
        bins.push(normalized);
    }

    bins
}
