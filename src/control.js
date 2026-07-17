// Control panel — device selection, monitor management, visualization mode picker

import { invoke } from "@tauri-apps/api/core";
import { listen, emit } from "@tauri-apps/api/event";

let audioDevices = [];
let monitors = [];
let activeVisualizers = new Set();
let currentMode = "spectrum";

export async function initControl() {
    const app = document.getElementById("app");
    app.innerHTML = renderShell();

    await refreshDevices();
    await refreshMonitors();
    bindEvents();
    setupModeSelector();
}

function renderShell() {
    return `
    <div class="control-panel">
        <header class="panel-header">
            <h1 class="logo">SkinnyV</h1>
            <div class="status-pill" id="status-pill">
                <span class="status-dot" id="status-dot"></span>
                <span id="status-text">Idle</span>
            </div>
        </header>

        <section class="panel-section">
            <h2>Audio Source</h2>
            <select id="device-select" class="select"></select>
            <button id="capture-toggle" class="btn btn-primary">Start Capture</button>
        </section>

        <section class="panel-section">
            <h2>Displays</h2>
            <div id="monitor-list" class="monitor-list"></div>
        </section>

        <section class="panel-section">
            <h2>Visualization Mode</h2>
            <div class="mode-grid" id="mode-grid">
                <button class="mode-btn active" data-mode="spectrum">Spectrum</button>
                <button class="mode-btn" data-mode="waveform">Waveform</button>
                <button class="mode-btn" data-mode="circular">Circular</button>
                <button class="mode-btn" data-mode="particles">Particles</button>
            </div>
        </section>

        <section class="panel-section">
            <h2>Color Theme</h2>
            <div class="theme-row" id="theme-row">
                <button class="theme-swatch active" data-theme="aurora" style="--c: #00f5d4"></button>
                <button class="theme-swatch" data-theme="sunset" style="--c: #f15bb5"></button>
                <button class="theme-swatch" data-theme="electric" style="--c: #00bbf9"></button>
                <button class="theme-swatch" data-theme="fire" style="--c: #ff6b35"></button>
                <button class="theme-swatch" data-theme="mono" style="--c: #ffffff"></button>
            </div>
        </section>

        <footer class="panel-footer">
            <span>SkinnyV 0.1.0 · GPL-3.0</span>
        </footer>
    </div>
    `;
}

async function refreshDevices() {
    try {
        audioDevices = await invoke("list_audio_devices");
    } catch (e) {
        console.error("Failed to list audio devices:", e);
        audioDevices = [];
    }
    const select = document.getElementById("device-select");
    if (audioDevices.length === 0) {
        select.innerHTML = `<option value="">No devices found</option>`;
    } else {
        select.innerHTML = audioDevices.map((d) =>
            `<option value="${d.id}" ${d.is_default ? "selected" : ""}>${d.name}${d.is_default ? " (Default)" : ""}</option>`
        ).join("");
    }
}

async function refreshMonitors() {
    try {
        monitors = await invoke("list_monitors");
    } catch (e) {
        console.error("Failed to list monitors:", e);
        monitors = [];
    }
    const list = document.getElementById("monitor-list");
    if (monitors.length === 0) {
        list.innerHTML = `<div class="monitor-card">No monitors detected</div>`;
        return;
    }
    list.innerHTML = monitors.map((m) => `
        <div class="monitor-card ${m.is_primary ? "primary" : ""}" data-monitor="${m.id}">
            <div class="monitor-icon">🖥</div>
            <div class="monitor-info">
                <span class="monitor-name">${m.name}${m.is_primary ? " (Primary)" : ""}</span>
                <span class="monitor-res">${m.width}×${m.height}</span>
            </div>
            <label class="toggle">
                <input type="checkbox" data-monitor="${m.id}" class="monitor-toggle">
                <span class="toggle-slider"></span>
            </label>
        </div>
    `).join("");

    document.querySelectorAll(".monitor-toggle").forEach((cb) => {
        cb.addEventListener("change", async (e) => {
            const monitorId = parseInt(e.target.dataset.monitor);
            if (e.target.checked) {
                try {
                    await invoke("open_visualizer_window", { monitorId });
                    activeVisualizers.add(monitorId);
                } catch (err) {
                    console.error("Failed to open visualizer:", err);
                    e.target.checked = false;
                }
            } else {
                try {
                    await invoke("close_visualizer_window", { monitorId });
                    activeVisualizers.delete(monitorId);
                } catch (err) {
                    console.error("Failed to close visualizer:", err);
                }
            }
        });
    });
}

function bindEvents() {
    const captureBtn = document.getElementById("capture-toggle");
    const deviceSelect = document.getElementById("device-select");

    captureBtn.addEventListener("click", async () => {
        const running = captureBtn.dataset.running === "true";
        if (running) {
            await invoke("stop_capture");
            captureBtn.textContent = "Start Capture";
            captureBtn.dataset.running = "false";
            captureBtn.classList.remove("btn-stop");
            captureBtn.classList.add("btn-primary");
            updateStatus(false, null);
        } else {
            const deviceId = deviceSelect.value || null;
            try {
                await invoke("start_capture", { deviceId });
                captureBtn.textContent = "Stop Capture";
                captureBtn.dataset.running = "true";
                captureBtn.classList.remove("btn-primary");
                captureBtn.classList.add("btn-stop");
                updateStatus(true, deviceId);
            } catch (err) {
                console.error("Failed to start capture:", err);
                showError(err);
            }
        }
    });

    deviceSelect.addEventListener("change", async () => {
        if (captureBtn.dataset.running === "true") {
            const deviceId = deviceSelect.value || null;
            try {
                await invoke("start_capture", { deviceId });
                updateStatus(true, deviceId);
            } catch (err) {
                console.error("Failed to switch device:", err);
            }
        }
    });
}

function setupModeSelector() {
    document.querySelectorAll(".mode-btn").forEach((btn) => {
        btn.addEventListener("click", () => {
            document.querySelectorAll(".mode-btn").forEach((b) => b.classList.remove("active"));
            btn.classList.add("active");
            currentMode = btn.dataset.mode;
            localStorage.setItem("skinnyv-mode", currentMode);
            emit("settings-change", { key: "mode", value: currentMode });
        });
    });

    document.querySelectorAll(".theme-swatch").forEach((btn) => {
        btn.addEventListener("click", () => {
            document.querySelectorAll(".theme-swatch").forEach((b) => b.classList.remove("active"));
            btn.classList.add("active");
            const theme = btn.dataset.theme;
            localStorage.setItem("skinnyv-theme", theme);
            emit("settings-change", { key: "theme", value: theme });
        });
    });
}

function updateStatus(running, device) {
    const dot = document.getElementById("status-dot");
    const text = document.getElementById("status-text");
    if (running) {
        dot.classList.add("active");
        text.textContent = device ? `Capturing: ${device}` : "Capturing";
    } else {
        dot.classList.remove("active");
        text.textContent = "Idle";
    }
}

function showError(msg) {
    const pill = document.getElementById("status-pill");
    pill.classList.add("error");
    document.getElementById("status-text").textContent = "Error";
    setTimeout(() => pill.classList.remove("error"), 3000);
}
