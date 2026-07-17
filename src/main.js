// SkinnyV frontend entry point
// Detects whether this window is the control panel or a visualizer
// and loads the appropriate module.

const url = new URL(window.location.href);
const isVisualizer = url.searchParams.has("viz");

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
    document.getElementById("app").innerHTML = `<div style="color:#ff4757;padding:20px">Failed to start: ${e}</div>`;
});
