import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

export default defineConfig({
  plugins: [react()],
  envDir: fileURLToPath(new URL("..", import.meta.url)),
  server: {
    port: 5174,
    proxy: {
      "/v1": {
        target: "http://127.0.0.1:8787",
        configure(proxy) {
          proxy.on("error", (_err, _req, res) => {
            if ("writeHead" in res && !res.headersSent) {
              res.writeHead(502, { "content-type": "application/json" });
              res.end(JSON.stringify({ error: "Local API worker is not running on :8787." }));
            }
          });
        },
      },
    },
  },
});
