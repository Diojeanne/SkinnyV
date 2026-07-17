// SkinnyV frontend entry point
// Uses URL hash (#viz) to detect visualizer windows — no Tauri API needed at init.

const isVisualizer = window.location.hash === "#viz";

async function start() {
    if (isVisualizer) {
        const m = await import("./visualizer.js");
        m.initVisualizer();
    } else {
        const m = await import("./control.js");
        m.initControl();
    }
}

start().catch((e) => {
    console.error("Failed to start SkinnyV:", e);
    document.getElementById("app").innerHTML =
        `<div style="color:#ff4757;padding:20px;font-family:monospace;font-size:14px">` +
        `SkinnyV failed to start: ${e}</div>`;
});
