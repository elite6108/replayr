import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

export default defineConfig({
  plugins: [react()],
  envDir: fileURLToPath(new URL("..", import.meta.url)),
  server: {
    port: 5174,
    proxy: {
      "/v1": "http://127.0.0.1:8787",
    },
  },
});
