// SkinnyV frontend entry point
// Detects whether this window is the control panel or a visualizer
// and loads the appropriate module.

const url = new URL(window.location.href);
const isVisualizer = url.searchParams.has("viz");

if (isVisualizer) {
    import("./visualizer.js").then((m) => m.initVisualizer());
} else {
    import("./control.js").then((m) => m.initControl());
}
