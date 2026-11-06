import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

/** The public beta page is a static file. Without this, the SPA catch-all sends /coming-soon to the homepage. */
function comingSoonPage(): Plugin {
  return {
    name: "coming-soon-page",
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        const [path, query] = (req.url || "").split("?");
        const bare = path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
        if (bare === "/coming-soon" || bare === "/waitlist") {
          req.url = `/coming-soon.html${query ? `?${query}` : ""}`;
        }
        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [comingSoonPage(), react()],
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
