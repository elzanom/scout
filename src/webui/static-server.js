import fs from "fs";
import path from "path";
import { repoPath } from "../../repo-root.js";

const DIST = repoPath("src", "webui-dist");

const MIME = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

export function serveStatic(req, res) {
  const url = new URL(req.url, "http://localhost");
  let filePath = path.join(DIST, decodeURIComponent(url.pathname).replace(/^\/dashboard/, ""));
  if (filePath.endsWith("/") || !path.extname(filePath)) filePath = path.join(filePath, "index.html");
  if (!filePath.startsWith(DIST)) return false;
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) return false;

  const ext = path.extname(filePath);
  res.writeHead(200, { "content-type": MIME[ext] || "application/octet-stream" });
  fs.createReadStream(filePath).pipe(res);
  return true;
}
