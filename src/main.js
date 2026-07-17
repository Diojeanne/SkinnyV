// SkinnyV control panel entry point — only loaded by index.html (the control window)

import { initControl } from "./control.js";
initControl().catch((e) => {
    console.error("Failed to start SkinnyV:", e);
    document.getElementById("app").innerHTML =
        `<div style="color:#ff4757;padding:20px;font-family:monospace;font-size:14px">` +
        `SkinnyV failed to start: ${e}</div>`;
});
