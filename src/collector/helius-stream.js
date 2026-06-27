import http from "http";
import { fileURLToPath } from "url";
import { config } from "../../config/config.js";
import { log, logAction } from "../utils/logger.js";
import { parseWebhookPayload } from "./tx-parser.js";

/**
 * Helius webhook receiver (native http — no web framework, per CLAUDE.md rule 4).
 *
 * Receives enhanced-transaction payloads fired by Helius. At registration time the webhook
 * is filtered to the Meteora DLMM program (there is no typed `transactionType` for Meteora),
 * so every payload is assumed to be Meteora activity. This is the real-time spine for
 * tx-mining (discover new wallets) and tracked-wallet position-refresh triggers.
 *
 * Dispatch is delegated to an injectable handler so this module stays free of DB/wiring
 * concerns (Phase 3 / src/index.js wires the real handler).
 */

// Default handler: log only. Replaced via onActivity() by the orchestrator.
let activityHandler = async (events) => {
  for (const ev of events) {
    log("webhook", `activity ${ev.wallet?.slice(0, 8) ?? "?"}… meteora=${ev.isMeteora} pools=${ev.pools.length} sig=${ev.signature?.slice(0, 8) ?? "?"}`);
  }
};

/** Register the activity dispatcher (called by Phase 3 orchestrator / index.js). */
export function onActivity(handler) {
  if (typeof handler === "function") activityHandler = handler;
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => resolve(""));
  });
}

async function handleWebhook(req, res, secret) {
  const body = await readBody(req);

  if (secret) {
    const provided = req.headers["x-helius-secret"] || req.headers["x-webhook-secret"];
    if (provided !== secret) {
      log("webhook_warn", `rejected: bad/missing secret (ip=${req.socket.remoteAddress})`);
      res.writeHead(401, { "content-type": "text/plain" });
      res.end("unauthorized");
      return;
    }
  }

  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    res.writeHead(400, { "content-type": "text/plain" });
    res.end("invalid json");
    return;
  }

  const events = parseWebhookPayload(payload, { assumeMeteora: true });
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ received: events.length }));

  const t0 = Date.now();
  try {
    await activityHandler(events);
    logAction({ tool: "webhook_receive", success: true, duration_ms: Date.now() - t0, args: { events: events.length }, result: {} });
  } catch (err) {
    log("webhook_error", `handler failed: ${err.message}`);
    logAction({ tool: "webhook_receive", success: false, duration_ms: Date.now() - t0, args: { events: events.length }, result: { error: err.message } });
  }
}

/** Build the http server (testable without binding). */
export function createServer({ secret = config.env.heliusWebhookSecret } = {}) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (req.method === "GET" && url.pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.method === "POST" && url.pathname === "/webhook/helius") {
      await handleWebhook(req, res, secret);
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });
}

/** Bind the webhook receiver to WEBHOOK_PORT. Returns the http.Server. */
export function startWebhookServer({ port = config.env.webhookPort, secret = config.env.heliusWebhookSecret } = {}) {
  const server = createServer({ secret });
  server.listen(port, () => {
    log("startup", `webhook receiver on :${port} (secret ${config.env.heliusWebhookSecret ? "enabled" : "OFF — dev mode"})`);
  });
  return server;
}

// Standalone PM2 entry: `node src/collector/helius-stream.js`
const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] === __filename) {
  startWebhookServer();
}
