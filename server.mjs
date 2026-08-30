import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const distDir = path.join(__dirname, "dist");
const port = Number(process.env.PORT || 8080);
const agentToken = process.env.MAGHRABI_AGENT_TOKEN || "";

let device = {
  online: false,
  displayName: "HOME-PC",
  os: "Windows PC",
  lastSeen: null,
  agentVersion: null,
};

function json(res, status, payload) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(JSON.stringify(payload));
}

function safeEqual(a, b) {
  const aa = Buffer.from(a || "");
  const bb = Buffer.from(b || "");
  return aa.length === bb.length && aa.length > 0 && crypto.timingSafeEqual(aa, bb);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 64 * 1024) {
        reject(new Error("Payload too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function publicStatus() {
  const lastSeenMs = device.lastSeen ? Date.parse(device.lastSeen) : 0;
  const online = Boolean(lastSeenMs && Date.now() - lastSeenMs < 45_000);
  return {
    online,
    displayName: device.displayName || "HOME-PC",
    os: device.os || "Windows PC",
    lastSeen: device.lastSeen,
    agentVersion: device.agentVersion,
  };
}

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".json": "application/json; charset=utf-8",
  }[ext] || "application/octet-stream";
}

function serveStatic(req, res) {
  const requestPath = decodeURIComponent((req.url || "/").split("?")[0]);
  const relative = requestPath === "/" ? "index.html" : requestPath.replace(/^\/+/, "");
  let filePath = path.join(distDir, relative);

  if (!filePath.startsWith(distDir)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(distDir, "index.html");
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    res.writeHead(200, {
      "Content-Type": contentType(filePath),
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  if (req.method === "GET" && url.pathname === "/api/health") {
    return json(res, 200, { ok: true, service: "MAGHRABI Remote", agentConfigured: Boolean(agentToken) });
  }

  if (req.method === "GET" && url.pathname === "/api/device-status") {
    return json(res, 200, publicStatus());
  }

  if (req.method === "POST" && url.pathname === "/api/agent/heartbeat") {
    if (!agentToken) {
      return json(res, 503, { ok: false, error: "MAGHRABI_AGENT_TOKEN is not configured on Railway" });
    }

    const auth = req.headers.authorization || "";
    const supplied = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!safeEqual(supplied, agentToken)) {
      return json(res, 401, { ok: false, error: "Unauthorized agent" });
    }

    try {
      const raw = await readBody(req);
      const payload = JSON.parse(raw || "{}");
      device = {
        online: true,
        displayName: String(payload.displayName || "HOME-PC").slice(0, 80),
        os: String(payload.os || "Windows PC").slice(0, 120),
        lastSeen: new Date().toISOString(),
        agentVersion: String(payload.agentVersion || "1.0.0").slice(0, 32),
      };
      return json(res, 200, { ok: true, serverTime: device.lastSeen });
    } catch {
      return json(res, 400, { ok: false, error: "Invalid heartbeat payload" });
    }
  }

  if (url.pathname.startsWith("/api/")) {
    return json(res, 404, { ok: false, error: "Not found" });
  }

  serveStatic(req, res);
});

server.listen(port, "0.0.0.0", () => {
  console.log(`MAGHRABI Remote listening on 0.0.0.0:${port}`);
  console.log(`Agent authentication configured: ${Boolean(agentToken)}`);
});
