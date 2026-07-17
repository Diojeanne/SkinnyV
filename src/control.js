// Control panel — device selection, monitor management, visualization mode picker

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

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
    } catch {
        audioDevices = [];
    }
    const select = document.getElementById("device-select");
    select.innerHTML = audioDevices.map((d) =>
        `<option value="${d.id}" ${d.is_default ? "selected" : ""}>${d.name}${d.is_default ? " (Default)" : ""}</option>`
    ).join("");
}

async function refreshMonitors() {
    try {
        monitors = await invoke("list_monitors");
    } catch {
        monitors = [];
    }
    const list = document.getElementById("monitor-list");
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

    // Bind toggle events
    document.querySelectorAll(".monitor-toggle").forEach((cb) => {
        cb.addEventListener("change", async (e) => {
            const monitorId = parseInt(e.target.dataset.monitor);
            if (e.target.checked) {
                try {
                    const label = await invoke("open_visualizer_window", { monitorId });
                    activeVisualizers.add(monitorId);
                    // Navigate the new window to the visualizer view
                    // The new window loads index.html — we need to tell it to be a visualizer
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

    // Monitor refresh button (if we add one later)
    deviceSelect.addEventListener("change", async () => {
        // If running, restart with new device
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
            // Persist to localStorage so visualizer windows can read it
            localStorage.setItem("skinnyv-mode", currentMode);
            // Broadcast to all visualizer windows via Tauri event
            broadcastSetting("mode", currentMode);
        });
    });

    document.querySelectorAll(".theme-swatch").forEach((btn) => {
        btn.addEventListener("click", () => {
            document.querySelectorAll(".theme-swatch").forEach((b) => b.classList.remove("active"));
            btn.classList.add("active");
            const theme = btn.dataset.theme;
            localStorage.setItem("skinnyv-theme", theme);
            broadcastSetting("theme", theme);
        });
    });
}

async function broadcastSetting(key, value) {
    // Emit a settings-change event that all visualizer windows listen for
    try {
        const { emit } = window.__TAURI__.event;
        await emit("settings-change", { key, value });
    } catch {
        // Non-fatal
    }
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
