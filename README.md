# SkinnyV

A lean, modern system audio visualizer with multi-monitor support.

## What it does

- Captures system audio (WASAPI loopback on Windows) — anything playing through your speakers
- Renders real-time visualizations on any or all connected displays
- Modern, minimal UI — not 1995-core
- Tiny binary (uses system WebView2, no bundled browser)

## Visualization modes

- **Spectrum** — Classic frequency bars with glow and reflection
- **Waveform** — Oscilloscope-style with trailing layers
- **Circular** — Radial frequency spokes with beat-reactive center pulse
- **Particles** — Beat-triggered particle bursts from center

## Color themes

Aurora, Sunset, Electric, Fire, Mono

## Building

### Prerequisites

- Rust 1.70+ (rustup recommended)
- Node.js 18+
- On Windows: WebView2 runtime (pre-installed on Windows 11)

### Dev mode

```bash
npm install
cargo tauri dev
```

### Production build

```bash
npm install
cargo tauri build
```

This produces an MSI or NSIS installer in `src-tauri/target/release/bundle/`.

## Architecture

```
Rust Backend (src-tauri/)
├── audio.rs    — cpal WASAPI loopback capture
├── fft.rs      — FFT frequency bin computation (log-spaced)
├── commands.rs — Tauri commands (device list, monitor mgmt, window control)
└── lib.rs      — App setup and event wiring

Frontend (src/)
├── main.js       — Entry point, routes control vs visualizer
├── control.js    — Control panel UI (device/source/display/mode selection)
├── visualizer.js — Canvas rendering (4 modes, 5 themes, beat detection)
└── style.css     — Modern dark UI
```

Audio data flows: WASAPI → ring buffer → FFT (2048-sample, Hann window) → 128 log-spaced bins → Tauri event → Canvas render at 60fps.

## License

GPL-3.0
