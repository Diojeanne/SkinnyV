// Visualizer renderer — runs in borderless fullscreen windows on selected monitors
// Listens for audio-data events from the Rust backend and renders to canvas

const { listen } = window.__TAURI__.event;

let canvas, ctx;
let mode = "spectrum";
let theme = "aurora";
let bins = new Float32Array(128);
let volume = 0;
let peak = 0;
let beat = false;
let beatPulse = 0;

// Smoothing buffers
let smoothedBins = new Float32Array(128);
let waveformHistory = [];

// Particle system for particle mode
let particles = [];

const THEMES = {
    aurora:  ["#00f5d4", "#00bbf9", "#9b5de5", "#f15bb5"],
    sunset:  ["#ff6b35", "#f7931e", "#f15bb5", "#fee440"],
    electric:["#00bbf9", "#00f5d4", "#0077b6", "#03045e"],
    fire:    ["#ff6b35", "#f72585", "#ffba08", "#dc2f02"],
    mono:    ["#ffffff", "#cccccc", "#888888", "#444444"],
};

export async function initVisualizer() {
    canvas = document.createElement("canvas");
    canvas.id = "viz-canvas";
    document.body.appendChild(canvas);
    document.body.style.margin = "0";
    document.body.style.overflow = "hidden";
    document.body.style.background = "#000";

    ctx = canvas.getContext("2d");

    resize();
    window.addEventListener("resize", resize);

    // Load saved settings
    mode = localStorage.getItem("skinnyv-mode") || "spectrum";
    theme = localStorage.getItem("skinnyv-theme") || "aurora";

    // Listen for audio data from backend
    await listen("audio-data", (event) => {
        const data = event.payload;
        bins = new Float32Array(data.bins);
        volume = data.volume;
        peak = data.peak;
        if (data.beat) {
            beat = true;
            beatPulse = 1.0;
        }
    });

    // Listen for settings changes from control panel
    await listen("settings-change", (event) => {
        const { key, value } = event.payload;
        if (key === "mode") mode = value;
        if (key === "theme") theme = value;
    });

    // Start render loop
    requestAnimationFrame(render);
}

function resize() {
    canvas.width = window.innerWidth * window.devicePixelRatio;
    canvas.height = window.innerHeight * window.devicePixelRatio;
    canvas.style.width = "100vw";
    canvas.style.height = "100vh";
}

function getThemeColors() {
    return THEMES[theme] || THEMES.aurora;
}

function render() {
    // Fade trail effect (semi-transparent black overlay)
    ctx.fillStyle = "rgba(0, 0, 0, 0.15)";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Smooth bins (exponential moving average for fluid motion)
    for (let i = 0; i < bins.length; i++) {
        smoothedBins[i] = smoothedBins[i] * 0.7 + bins[i] * 0.3;
    }

    // Decay beat pulse
    beatPulse *= 0.92;

    switch (mode) {
        case "spectrum":
            renderSpectrum();
            break;
        case "waveform":
            renderWaveform();
            break;
        case "circular":
            renderCircular();
            break;
        case "particles":
            renderParticles();
            break;
    }

    requestAnimationFrame(render);
}

// ─── SPECTRUM BARS ────────────────────────────────────────────
function renderSpectrum() {
    const colors = getThemeColors();
    const w = canvas.width;
    const h = canvas.height;
    const barCount = 64;
    const barWidth = w / barCount;
    const gap = barWidth * 0.15;

    for (let i = 0; i < barCount; i++) {
        const binIdx = Math.floor((i / barCount) * smoothedBins.length);
        const value = smoothedBins[binIdx];
        const barH = value * h * 0.85;

        const x = i * barWidth + gap / 2;
        const y = h - barH;

        // Gradient based on height
        const t = i / barCount;
        const colorIdx = Math.floor(t * colors.length);
        const color = colors[Math.min(colorIdx, colors.length - 1)];

        // Main bar
        ctx.fillStyle = color;
        ctx.fillRect(x, y, barWidth - gap, barH);

        // Glow effect
        ctx.shadowBlur = 20 * value;
        ctx.shadowColor = color;
        ctx.fillRect(x, y, barWidth - gap, barH);
        ctx.shadowBlur = 0;

        // Reflection
        ctx.globalAlpha = 0.2;
        ctx.fillRect(x, h, barWidth - gap, -barH * 0.3);
        ctx.globalAlpha = 1.0;
    }

    // Beat flash overlay
    if (beatPulse > 0.1) {
        ctx.fillStyle = `rgba(255, 255, 255, ${beatPulse * 0.05})`;
        ctx.fillRect(0, 0, w, h);
    }
}

// ─── WAVEFORM ──────────────────────────────────────────────────
function renderWaveform() {
    const colors = getThemeColors();
    const w = canvas.width;
    const h = canvas.height;
    const midY = h / 2;

    // Store current frame for history trail
    const frame = new Float32Array(smoothedBins.length);
    for (let i = 0; i < smoothedBins.length; i++) {
        frame[i] = smoothedBins[i];
    }
    waveformHistory.push(frame);
    if (waveformHistory.length > 5) waveformHistory.shift();

    // Draw history trails with decreasing opacity
    for (let layer = 0; layer < waveformHistory.length; layer++) {
        const data = waveformHistory[layer];
        const opacity = (layer + 1) / waveformHistory.length * 0.6;
        const color = colors[layer % colors.length];

        ctx.strokeStyle = color;
        ctx.globalAlpha = opacity;
        ctx.lineWidth = 2;
        ctx.beginPath();

        for (let i = 0; i < data.length; i++) {
            const x = (i / data.length) * w;
            const y = midY + (data[i] - 0.5) * h * 0.6;
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
        }
        ctx.stroke();
    }
    ctx.globalAlpha = 1.0;

    // Main waveform — thick, glowing
    ctx.strokeStyle = colors[0];
    ctx.lineWidth = 4;
    ctx.shadowBlur = 15;
    ctx.shadowColor = colors[0];
    ctx.beginPath();
    for (let i = 0; i < smoothedBins.length; i++) {
        const x = (i / smoothedBins.length) * w;
        const y = midY + (smoothedBins[i] - 0.5) * h * 0.6;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.shadowBlur = 0;
}

// ─── CIRCULAR ──────────────────────────────────────────────────
function renderCircular() {
    const colors = getThemeColors();
    const w = canvas.width;
    const h = canvas.height;
    const cx = w / 2;
    const cy = h / 2;
    const baseRadius = Math.min(w, h) * 0.2;
    const maxExtension = Math.min(w, h) * 0.25;

    const segments = 128;

    for (let i = 0; i < segments; i++) {
        const angle = (i / segments) * Math.PI * 2 - Math.PI / 2;
        const binIdx = Math.floor((i / segments) * smoothedBins.length);
        const value = smoothedBins[binIdx];

        const r1 = baseRadius;
        const r2 = baseRadius + value * maxExtension;

        const x1 = cx + Math.cos(angle) * r1;
        const y1 = cy + Math.sin(angle) * r1;
        const x2 = cx + Math.cos(angle) * r2;
        const y2 = cy + Math.sin(angle) * r2;

        const t = i / segments;
        const color = colors[Math.floor(t * colors.length) % colors.length];

        ctx.strokeStyle = color;
        ctx.lineWidth = 3;
        ctx.shadowBlur = 10 * value;
        ctx.shadowColor = color;
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
    }
    ctx.shadowBlur = 0;

    // Inner circle pulse on beat
    if (beatPulse > 0.1) {
        ctx.strokeStyle = colors[0];
        ctx.globalAlpha = beatPulse * 0.5;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(cx, cy, baseRadius * (1 + beatPulse * 0.2), 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = 1.0;
    }

    // Center glow
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, baseRadius);
    grad.addColorStop(0, colors[0] + "40");
    grad.addColorStop(1, "transparent");
    ctx.fillStyle = grad;
    ctx.fillRect(cx - baseRadius, cy - baseRadius, baseRadius * 2, baseRadius * 2);
}

// ─── PARTICLES ─────────────────────────────────────────────────
function renderParticles() {
    const colors = getThemeColors();
    const w = canvas.width;
    const h = canvas.height;
    const cx = w / 2;
    const cy = h / 2;

    // Spawn particles on beat
    if (beatPulse > 0.5) {
        const count = Math.floor(beatPulse * 20);
        for (let i = 0; i < count; i++) {
            const angle = Math.random() * Math.PI * 2;
            const speed = 2 + Math.random() * 6 * (volume * 10);
            particles.push({
                x: cx,
                y: cy,
                vx: Math.cos(angle) * speed,
                vy: Math.sin(angle) * speed,
                life: 1.0,
                color: colors[Math.floor(Math.random() * colors.length)],
                size: 2 + Math.random() * 4,
            });
        }
    }

    // Also spawn based on volume
    if (volume > 0.01) {
        const count = Math.floor(volume * 5);
        for (let i = 0; i < count; i++) {
            const angle = Math.random() * Math.PI * 2;
            const speed = 1 + Math.random() * 3 * (volume * 10);
            particles.push({
                x: cx + (Math.random() - 0.5) * 100,
                y: cy + (Math.random() - 0.5) * 100,
                vx: Math.cos(angle) * speed,
                vy: Math.sin(angle) * speed,
                life: 1.0,
                color: colors[Math.floor(Math.random() * colors.length)],
                size: 1 + Math.random() * 3,
            });
        }
    }

    // Update and draw particles
    for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        p.x += p.vx;
        p.y += p.vy;
        p.vx *= 0.99;
        p.vy *= 0.99;
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

    // Cap particle count for performance
    if (particles.length > 2000) {
        particles.splice(0, particles.length - 2000);
    }
}
