import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig(() => {
  // The desktop webview calls this dev server. Forward /v1 to the local worker
  // so the window does not have to reach 127.0.0.1 itself.
  const proxy = {
    "/v1": { target: "http://127.0.0.1:8787", changeOrigin: true },
  };

  return {
    plugins: [react()],
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "src"),
      },
    },
    clearScreen: false,
    build: {
      rollupOptions: {
        input: {
          main: path.resolve(__dirname, "index.html"),
          overlay: path.resolve(__dirname, "overlay.html"),
        },
      },
    },
    server: {
      port: 1420,
      strictPort: true,
      host: host || false,
      hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
      proxy,
      watch: {
        ignored: [
          "**/src-tauri/**",
          "**/target-sync-audit/**",
          "**/web/dist/**",
          "**/worker/.wrangler/**",
          "**/*.exe",
        ],
      },
    },
  };
});
