# SkinnyV

Copyright (C) 2026 Clarissa Millarker

SkinnyV is a lean, modern system audio visualizer with multi-monitor support. It captures system audio (WASAPI loopback on Windows; PipeWire/PulseAudio monitor sources on Linux) and renders real-time visualizations across any or all connected displays. Built with Tauri 2 + Rust + plain HTML/JS/CSS.

## Features

- **System audio capture** — WASAPI loopback on Windows, PipeWire/PulseAudio monitor sources on Linux — anything playing through your speakers
- **16 visualization modes** — Spectrum, Waveform, Circular, Particles, Radial Bars, Tunnel, Starburst, Wave Sea, Mirror, Matrix Rain, Terrain, Lattice, Bloom, Ribbon, Galaxy, Ripples
- **12 color themes** — Aurora, Sunset, Electric, Fire, Mono, Forest, Candy, Cyber, Deep Sea, Gold, Vapor, Blood
- **Auto-cycle themes** — optionally rotate through all themes every 8 seconds
- **Multi-monitor** — borderless fullscreen visualizer windows on any or all displays
- **Modern UI** — clean dark control panel, no 1995 vibes
- **Tiny binary** — uses system WebView2, no bundled browser (~14MB)
- **Beat detection** — rolling average comparison for reactive visual effects
- **Auto-gain normalization** — decaying rolling peak keeps visualizations dynamic across volume levels

## Building

### Prerequisites

Common:

- **Rust** 1.70+ ([rustup](https://rustup.rs))
- **Node.js** 18+ (only needed if you modify package.json)

**Windows:**

- **Visual Studio C++ Build Tools** (Desktop development with C++ workload)
- **WebView2 runtime** — pre-installed on Windows 11

**Linux** (Debian/Ubuntu package names; adjust for your distro):

```bash
sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev libsoup-3.0-dev \
  libjavascriptcoregtk-4.1-dev libpulse-dev librsvg2-dev patchelf
```

Capture uses the PulseAudio API, which works on both PulseAudio and PipeWire
(via `pipewire-pulse`, standard on modern desktops).

### Dev mode

```bash
git clone https://github.com/SkinnyV-Release-Team/SkinnyV.git
cd SkinnyV
cargo tauri dev
```

### Production build

```bash
cargo tauri build
```

Produces MSI + NSIS installers on Windows, or `.deb` + AppImage on Linux, in
`src-tauri/target/release/bundle/`.

## Architecture

```
Rust Backend (src-tauri/src/)
├── audio.rs    — capture (cpal WASAPI loopback on Windows / libpulse monitor on Linux), FFT, auto-gain, beat detection
├── commands.rs — Tauri commands (device list, monitor mgmt, window control)
└── lib.rs      — App setup, event wiring, clean shutdown

Frontend (index.html — single file, all inline)
├── CSS  — Modern dark theme with accent gradients
├── Control panel — device picker, display toggles, mode/theme selection, license viewer
└── Visualizer — 16 canvas render modes, beat-reactive, theme-aware
```

Audio data flows: system-audio capture (WASAPI loopback on Windows / PipeWire·PulseAudio monitor on Linux) → ring buffer → FFT (2048-sample Hann window) → 128 log-spaced bins with auto-gain normalization → Tauri event → Canvas render at 60fps.

## Usage

1. Launch SkinnyV — the control panel appears
2. Select an audio source (defaults to your system output)
3. Click **Start Capture**
4. Toggle displays on/off to spawn fullscreen visualizer windows
5. Pick a visualization mode and color theme
6. Press **ESC** to close a visualizer window
7. Closing the control panel exits the app

## License

Copyright (C) 2026 Clarissa Millarker

This program is free software: you can redistribute it and/or modify it under the terms of the GNU General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version.

This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU General Public License for more details.

You should have received a copy of the GNU General Public License along with this program. If not, see <https://www.gnu.org/licenses/>.
