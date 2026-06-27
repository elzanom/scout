import http from "http";
import { config } from "../config/config.js";
import { log } from "./utils/logger.js";
import { initDb, getDb, closeDb } from "./db/index.js";
import { handleApi } from "./webui/api-router.js";
import { initWebSocketServer } from "./webui/ws-broadcaster.js";
import { serveStatic } from "./webui/static-server.js";

function createWebuiServer() {
  return http.createServer((req, res) => {
    // CORS: allow LAN origins if configured
    const corsOrigin = process.env.DASHBOARD_CORS_ORIGIN || "*";
    res.setHeader("access-control-allow-origin", corsOrigin);
    res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
    res.setHeader("access-control-allow-headers", "content-type, x-dashboard-secret");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url, "http://localhost");

    // API routes
    if (url.pathname.startsWith("/api/")) {
      handleApi(req, res).catch((err) => {
        log("webui_error", `handleApi error: ${err.message}`);
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "internal server error" }));
      });
      return;
    }

    // Static dashboard assets (fallback to index.html for SPA routes)
    if (url.pathname === "/" || url.pathname.startsWith("/dashboard")) {
      if (serveStatic(req, res)) return;
      res.writeHead(200, { "content-type": "text/html" });
      res.end(serveIndexFallback());
      return;
    }

    // Unknown
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });
}

function serveIndexFallback() {
  try {
    return fs.readFileSync(repoPath("src", "webui-dist", "index.html"), "utf8");
  } catch {
    return `<!doctype html><html><body style="background:#0b0c10;color:#e6e6e6;font-family:sans-serif;padding:40px">
      <h1>Laminar Scout Dashboard</h1>
      <p>Static build not found. Run <code>npm run webui:build</code>.</p>
    </body></html>`;
  }
}

export function mountWebui(server) {
  initDb();
  initWebSocketServer(server);

  const listener = server.listeners("request")[0];
  if (listener) server.removeListener("request", listener);

  server.on("request", (req, res) => {
    const url = new URL(req.url, "http://localhost");

    const corsOrigin = process.env.DASHBOARD_CORS_ORIGIN || "*";
    res.setHeader("access-control-allow-origin", corsOrigin);
    res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
    res.setHeader("access-control-allow-headers", "content-type, x-dashboard-secret");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (url.pathname.startsWith("/api/")) {
      handleApi(req, res).catch((err) => {
        log("webui_error", `handleApi error: ${err.message}`);
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "internal server error" }));
      });
      return;
    }

    if (url.pathname === "/" || url.pathname.startsWith("/dashboard")) {
      if (serveStatic(req, res)) return;
      res.writeHead(200, { "content-type": "text/html" });
      res.end(serveIndexFallback());
      return;
    }

    // fall back to original webhook listener
    listener?.(req, res);
  });

  log("webui", `dashboard routes mounted on existing server (/dashboard, /api/*, /ws)`);
}

export function startWebuiServer({ port = Number(process.env.DASHBOARD_PORT) || 3001 } = {}) {
  const server = createWebuiServer();
  mountWebui(server);
  server.listen(port, "0.0.0.0", () => {
    log("webui", `dashboard server listening on http://0.0.0.0:${port}/dashboard`);
  });
  return server;
}

// Standalone entry: node src/webui-server.js
import { fileURLToPath } from "url";
const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] === __filename) {
  startWebuiServer();
}
