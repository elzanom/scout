import { WebSocketServer } from "ws";
import { log } from "../utils/logger.js";
import { getStateCache } from "./state-cache.js";

/** @type {WebSocketServer | null} */
let wss = null;

export function initWebSocketServer(server) {
  wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (request, socket, head) => {
    if (request.url === "/ws" || request.url?.startsWith("/ws")) {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit("connection", ws, request);
      });
    }
  });

  wss.on("connection", (ws) => {
    ws.isAlive = true;
    ws.subscriptions = new Set(["state", "signals", "snapshots", "logs", "cycles"]);

    ws.on("pong", () => { ws.isAlive = true; });
    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw);
        if (msg.type === "subscribe" && Array.isArray(msg.channels)) {
          ws.subscriptions = new Set(msg.channels);
        } else if (msg.type === "ping") {
          ws.send(JSON.stringify({ type: "pong" }));
        }
      } catch {}
    });

    // Initial state push
    ws.send(JSON.stringify({ type: "state", payload: getStateCache() }));
  });

  // Heartbeat to drop stale clients
  const interval = setInterval(() => {
    if (!wss) { clearInterval(interval); return; }
    for (const ws of wss.clients) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false;
      ws.ping();
    }
  }, 30000);

  wss.on("close", () => clearInterval(interval));

  log("webui", "WebSocket server mounted on /ws");
  return wss;
}

function broadcast(type, payload, channel) {
  if (!wss) return;
  const message = JSON.stringify({ type, payload });
  for (const ws of wss.clients) {
    if (ws.readyState === 1 && ws.subscriptions.has(channel)) {
      ws.send(message);
    }
  }
}

export function broadcastState() {
  broadcast("state", getStateCache(), "state");
}

export function broadcastSignal(signal) {
  broadcast("signal", signal, "signals");
}

export function broadcastSnapshot(snapshot) {
  broadcast("snapshot", snapshot, "snapshots");
}

export function broadcastLog(entry) {
  broadcast("log", entry, "logs");
}

export function broadcastCycle(name, startedAt, durationMs, success) {
  broadcast("cycle", { name, startedAt, durationMs, success }, "cycles");
}
