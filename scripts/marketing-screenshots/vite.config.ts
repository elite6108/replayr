import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

const repo = path.resolve(import.meta.dirname, "../..");
const mocks = path.resolve(import.meta.dirname, "src/tauri-mocks.ts");

export default defineConfig({
  root: import.meta.dirname,
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.join(repo, "src"),
      "@tauri-apps/api/core": mocks,
      "@tauri-apps/api/event": mocks,
      "@tauri-apps/api/window": mocks,
      "@tauri-apps/api/app": mocks,
      "@tauri-apps/plugin-autostart": mocks,
      "@tauri-apps/plugin-dialog": mocks,
      "@tauri-apps/plugin-updater": mocks,
      "@tauri-apps/plugin-process": mocks,
      "@tauri-apps/plugin-opener": mocks,
      "@tauri-apps/plugin-deep-link": mocks,
    },
  },
  server: {
    port: 4173,
    strictPort: true,
    host: "127.0.0.1",
  },
});
