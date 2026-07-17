// SkinnyV frontend entry point
// Detects whether this window is the control panel or a visualizer
// based on the Tauri window label, and loads the appropriate module.

import { getCurrentWindow } from "@tauri-apps/api/window";

async function start() {
    const label = getCurrentWindow().label;

    if (label.startsWith("visualizer")) {
        const m = await import("./visualizer.js");
        m.initVisualizer();
    } else {
        const m = await import("./control.js");
        m.initControl();
    }
}

start().catch((e) => {
    console.error("Failed to start SkinnyV:", e);
    document.getElementById("app").innerHTML = `<div style="color:#ff4757;padding:20px;font-family:monospace">Failed to start: ${e}</div>`;
});
