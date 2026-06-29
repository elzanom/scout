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

// Static asset aliases exposed at both /dashboard/* and root /*
export const ROOT_ALIASES = new Set(["/of.png", "/header.png"]);

export function serveStatic(req, res) {
  const url = new URL(req.url, "http://localhost");
  let pathname = decodeURIComponent(url.pathname);

  // Serve dashboard assets from /dashboard/*; also allow root aliases for images.
  if (ROOT_ALIASES.has(pathname)) {
    pathname = pathname; // keep as-is (e.g. /of.png maps to DIST/of.png)
  } else {
    pathname = pathname.replace(/^\/dashboard/, "");
  }

  let filePath = path.join(DIST, pathname);
  if (filePath.endsWith("/") || !path.extname(filePath)) filePath = path.join(filePath, "index.html");
  if (!filePath.startsWith(DIST)) return false;
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) return false;

  const ext = path.extname(filePath);
  res.writeHead(200, { "content-type": MIME[ext] || "application/octet-stream" });
  fs.createReadStream(filePath).pipe(res);
  return true;
}
