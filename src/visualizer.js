// Visualizer renderer — runs in borderless fullscreen windows on selected monitors
// Listens for audio-data events from the Rust backend and renders to canvas

let listenFn = null;

let canvas, ctx;
let mode = "spectrum";
let theme = "aurora";
let bins = new Float32Array(128);
let volume = 0;
let peak = 0;
let beat = false;
let beatPulse = 0;

let smoothedBins = new Float32Array(128);
let waveformHistory = [];
let particles = [];

const THEMES = {
    aurora:  ["#00f5d4", "#00bbf9", "#9b5de5", "#f15bb5"],
    sunset:  ["#ff6b35", "#f7931e", "#f15bb5", "#fee440"],
    electric:["#00bbf9", "#00f5d4", "#0077b6", "#03045e"],
    fire:    ["#ff6b35", "#f72585", "#ffba08", "#dc2f02"],
    mono:    ["#ffffff", "#cccccc", "#888888", "#444444"],
};

export async function initVisualizer() {
    // Set black background immediately
    document.documentElement.style.background = "#000";
    document.body.style.margin = "0";
    document.body.style.overflow = "hidden";
    document.body.style.background = "#000";
    document.getElementById("app").style.display = "none";

    canvas = document.createElement("canvas");
    canvas.id = "viz-canvas";
    document.body.appendChild(canvas);

    ctx = canvas.getContext("2d");
    if (!ctx) {
        console.error("[SkinnyV] Failed to get 2D context");
        return;
    }

    resize();
    window.addEventListener("resize", resize);

    // Escape key closes the visualizer window
    window.addEventListener("keydown", (e) => {
        if (e.key === "Escape") {
            // Try Tauri close, fall back to window.close
            import("@tauri-apps/api/window")
                .then((m) => m.getCurrentWindow().close())
                .catch(() => window.close());
        }
    });

    // Load saved settings
    mode = localStorage.getItem("skinnyv-mode") || "spectrum";
    theme = localStorage.getItem("skinnyv-theme") || "aurora";

    // Load Tauri event API dynamically
    try {
        const event = await import("@tauri-apps/api/event");
        listenFn = event.listen;

        await listenFn("audio-data", (event) => {
            const data = event.payload;
            if (data && data.bins) {
                bins = new Float32Array(data.bins);
                volume = data.volume;
                peak = data.peak;
                if (data.beat) {
                    beat = true;
                    beatPulse = 1.0;
                }
            }
        });

        await listenFn("settings-change", (event) => {
            const { key, value } = event.payload;
            if (key === "mode") mode = value;
            if (key === "theme") theme = value;
        });

        console.log("[SkinnyV] Visualizer listening for events");
    } catch (e) {
        console.error("[SkinnyV] Failed to setup Tauri event listeners:", e);
    }

    // Draw initial black frame
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    requestAnimationFrame(render);
}

function resize() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    canvas.style.width = "100vw";
    canvas.style.height = "100vh";
}

function getThemeColors() {
    return THEMES[theme] || THEMES.aurora;
}

function render() {
    ctx.fillStyle = "rgba(0, 0, 0, 0.15)";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    for (let i = 0; i < bins.length; i++) {
        smoothedBins[i] = smoothedBins[i] * 0.7 + bins[i] * 0.3;
    }
    beatPulse *= 0.92;

    try {
        switch (mode) {
            case "spectrum": renderSpectrum(); break;
            case "waveform": renderWaveform(); break;
            case "circular": renderCircular(); break;
            case "particles": renderParticles(); break;
        }
    } catch (e) {
        // Don't let a render error kill the loop
    }

    requestAnimationFrame(render);
}

function renderSpectrum() {
    const colors = getThemeColors();
    const w = canvas.width, h = canvas.height;
    const barCount = 64;
    const barWidth = w / barCount;
    const gap = barWidth * 0.15;

    for (let i = 0; i < barCount; i++) {
        const binIdx = Math.floor((i / barCount) * smoothedBins.length);
        const value = smoothedBins[binIdx];
        const barH = value * h * 0.85;
        const x = i * barWidth + gap / 2;
        const y = h - barH;
        const t = i / barCount;
        const color = colors[Math.min(Math.floor(t * colors.length), colors.length - 1)];

        ctx.fillStyle = color;
        ctx.fillRect(x, y, barWidth - gap, barH);
        ctx.shadowBlur = 20 * value;
        ctx.shadowColor = color;
        ctx.fillRect(x, y, barWidth - gap, barH);
        ctx.shadowBlur = 0;
        ctx.globalAlpha = 0.2;
        ctx.fillRect(x, h, barWidth - gap, -barH * 0.3);
        ctx.globalAlpha = 1.0;
    }

    if (beatPulse > 0.1) {
        ctx.fillStyle = `rgba(255,255,255,${beatPulse * 0.05})`;
        ctx.fillRect(0, 0, w, h);
    }
}

function renderWaveform() {
    const colors = getThemeColors();
    const w = canvas.width, h = canvas.height;
    const midY = h / 2;

    const frame = new Float32Array(smoothedBins.length);
    for (let i = 0; i < smoothedBins.length; i++) frame[i] = smoothedBins[i];
    waveformHistory.push(frame);
    if (waveformHistory.length > 5) waveformHistory.shift();

    for (let layer = 0; layer < waveformHistory.length; layer++) {
        const data = waveformHistory[layer];
        const opacity = (layer + 1) / waveformHistory.length * 0.6;
        ctx.strokeStyle = colors[layer % colors.length];
        ctx.globalAlpha = opacity;
        ctx.lineWidth = 2;
        ctx.beginPath();
        for (let i = 0; i < data.length; i++) {
            const x = (i / data.length) * w;
            const y = midY + (data[i] - 0.5) * h * 0.6;
            if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.stroke();
    }
    ctx.globalAlpha = 1.0;

    ctx.strokeStyle = colors[0];
    ctx.lineWidth = 4;
    ctx.shadowBlur = 15;
    ctx.shadowColor = colors[0];
    ctx.beginPath();
    for (let i = 0; i < smoothedBins.length; i++) {
        const x = (i / smoothedBins.length) * w;
        const y = midY + (smoothedBins[i] - 0.5) * h * 0.6;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.shadowBlur = 0;
}

function renderCircular() {
    const colors = getThemeColors();
    const w = canvas.width, h = canvas.height;
    const cx = w / 2, cy = h / 2;
    const baseRadius = Math.min(w, h) * 0.2;
    const maxExtension = Math.min(w, h) * 0.25;
    const segments = 128;

    for (let i = 0; i < segments; i++) {
        const angle = (i / segments) * Math.PI * 2 - Math.PI / 2;
        const binIdx = Math.floor((i / segments) * smoothedBins.length);
        const value = smoothedBins[binIdx];
        const r1 = baseRadius;
        const r2 = baseRadius + value * maxExtension;
        const color = colors[Math.floor((i / segments) * colors.length) % colors.length];

        ctx.strokeStyle = color;
        ctx.lineWidth = 3;
        ctx.shadowBlur = 10 * value;
        ctx.shadowColor = color;
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(angle) * r1, cy + Math.sin(angle) * r1);
        ctx.lineTo(cx + Math.cos(angle) * r2, cy + Math.sin(angle) * r2);
        ctx.stroke();
    }
    ctx.shadowBlur = 0;

    if (beatPulse > 0.1) {
        ctx.strokeStyle = colors[0];
        ctx.globalAlpha = beatPulse * 0.5;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(cx, cy, baseRadius * (1 + beatPulse * 0.2), 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = 1.0;
    }

    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, baseRadius);
    grad.addColorStop(0, colors[0] + "40");
    grad.addColorStop(1, "transparent");
    ctx.fillStyle = grad;
    ctx.fillRect(cx - baseRadius, cy - baseRadius, baseRadius * 2, baseRadius * 2);
}

function renderParticles() {
    const colors = getThemeColors();
    const w = canvas.width, h = canvas.height;
    const cx = w / 2, cy = h / 2;

    if (beatPulse > 0.5) {
        const count = Math.floor(beatPulse * 20);
        for (let i = 0; i < count; i++) {
            const angle = Math.random() * Math.PI * 2;
            const speed = 2 + Math.random() * 6 * (volume * 10);
            particles.push({
                x: cx, y: cy,
                vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed,
                life: 1.0,
                color: colors[Math.floor(Math.random() * colors.length)],
                size: 2 + Math.random() * 4,
            });
        }
    }

    if (volume > 0.01) {
        const count = Math.floor(volume * 5);
        for (let i = 0; i < count; i++) {
            const angle = Math.random() * Math.PI * 2;
            const speed = 1 + Math.random() * 3 * (volume * 10);
            particles.push({
                x: cx + (Math.random() - 0.5) * 100,
                y: cy + (Math.random() - 0.5) * 100,
                vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed,
                life: 1.0,
                color: colors[Math.floor(Math.random() * colors.length)],
                size: 1 + Math.random() * 3,
            });
        }
    }

    for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        p.x += p.vx; p.y += p.vy;
        p.vx *= 0.99; p.vy *= 0.99;
        p.life -= 0.01;
        if (p.life <= 0 || p.x < -50 || p.x > w + 50 || p.y < -50 || p.y > h + 50) {
            particles.splice(i, 1);
            continue;
        }
        ctx.globalAlpha = p.life;
        ctx.fillStyle = p.color;
        ctx.shadowBlur = p.size * 3;
        ctx.shadowColor = p.color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fill();
    }
    ctx.globalAlpha = 1.0;
    ctx.shadowBlur = 0;
    if (particles.length > 2000) particles.splice(0, particles.length - 2000);
}
