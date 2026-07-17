import { defineConfig } from "vite";

export default defineConfig({
  server: {
    port: 1420,
    strictPort: true,
  },
  build: {
    target: "esnext",
    outDir: "dist",
    rollupOptions: {
      input: {
        main: "index.html",
        viz: "viz.html",
      },
    },
  },
  clearScreen: false,
});
