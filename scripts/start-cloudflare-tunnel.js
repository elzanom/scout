#!/usr/bin/env node
/**
 * Start a Cloudflare Tunnel for the Laminar Scout dashboard.
 *
 * Modes:
 *   1. Quick tunnel (default): random *.trycloudflare.com URL, no account needed.
 *      node scripts/start-cloudflare-tunnel.js
 *
 *   2. Named tunnel: stable domain, requires Cloudflare account + token.
 *      CLOUDFLARE_TUNNEL_TOKEN=xxx node scripts/start-cloudflare-tunnel.js
 *
 * The tunnel points to the local dashboard on DASHBOARD_PORT (default 8080).
 */
import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { config } from "../config/config.js";
import { log } from "../src/utils/logger.js";
import { repoPath } from "../repo-root.js";

const DASHBOARD_PORT = Number(process.env.DASHBOARD_PORT) || 8080;
const TUNNEL_TOKEN = process.env.CLOUDFLARE_TUNNEL_TOKEN || "";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CANDIDATES = [
  path.resolve(__dirname, "..", "bin", "cloudflared"),
  path.resolve(__dirname, "..", "cloudflared"),
  "/usr/bin/cloudflared",
  "/usr/local/bin/cloudflared",
  "/opt/cloudflared/cloudflared",
];

function findCloudflared() {
  for (const c of CANDIDATES) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

function main() {
  const binary = findCloudflared();
  if (!binary) {
    log("tunnel_error", "cloudflared binary not found. Install it first: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/");
    process.exit(1);
  }
  log("tunnel", `using cloudflared: ${binary}`);

  const localUrl = `http://localhost:${DASHBOARD_PORT}`;
  let args;
  if (TUNNEL_TOKEN) {
    args = ["tunnel", "run", "--token", TUNNEL_TOKEN];
    log("tunnel", `starting named tunnel → ${localUrl}`);
  } else {
    args = ["tunnel", "--url", localUrl];
    log("tunnel", `starting quick tunnel → ${localUrl} (random *.trycloudflare.com URL)`);
  }

  const proc = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"] });

  proc.stdout.on("data", (data) => {
    const text = String(data).trim();
    if (!text) return;
    // Extract public URL from quick tunnel output
    const match = text.match(/(https?:\/\/[a-z0-9-]+\.trycloudflare\.com)/);
    if (match) {
      log("tunnel", `public dashboard URL: ${match[1]}`);
      try {
        fs.writeFileSync(repoPath("dashboard-tunnel-url.txt"), match[1]);
      } catch {}
    }
    log("tunnel_stdout", text);
  });

  proc.stderr.on("data", (data) => {
    const text = String(data).trim();
    if (text) log("tunnel_stderr", text);
  });

  proc.on("error", (err) => {
    log("tunnel_error", `failed to start cloudflared: ${err.message}`);
    process.exit(1);
  });

  proc.on("exit", (code) => {
    log("tunnel", `cloudflared exited with code ${code}`);
    process.exit(code ?? 0);
  });

  process.on("SIGINT", () => {
    proc.kill("SIGINT");
  });
  process.on("SIGTERM", () => {
    proc.kill("SIGTERM");
  });
}

main();
