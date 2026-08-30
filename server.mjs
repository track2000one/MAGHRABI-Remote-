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
const ownerPassword = process.env.MAGHRABI_OWNER_PASSWORD || "";
const sessionSecret = process.env.MAGHRABI_SESSION_SECRET || crypto
  .createHash("sha256")
  .update(`${ownerPassword}|${agentToken}|MAGHRABI-REMOTE`)
  .digest("hex");

let device = {
  online: false,
  displayName: "HOME-PC",
  os: "Windows PC",
  lastSeen: null,
  agentVersion: null,
};

let viewerActiveUntil = 0;
let latestFrame = null;
let latestFrameAt = null;
let sessionsToday = 0;
let sessionsDate = new Date().toISOString().slice(0, 10);
let inputSeq = 0;
let inputQueue = [];
const failedLogins = new Map();

function json(res, status, payload, extraHeaders = {}) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...extraHeaders,
  });
  res.end(JSON.stringify(payload));
}

function safeEqual(a, b) {
  const aa = Buffer.from(a || "");
  const bb = Buffer.from(b || "");
  return aa.length === bb.length && aa.length > 0 && crypto.timingSafeEqual(aa, bb);
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (Buffer.byteLength(data) > limit) {
        reject(new Error("Payload too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function readBinary(req, limit = 3 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("Payload too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function publicStatus() {
  const lastSeenMs = device.lastSeen ? Date.parse(device.lastSeen) : 0;
  const online = Boolean(lastSeenMs && Date.now() - lastSeenMs < 45_000);
  if (sessionsDate !== new Date().toISOString().slice(0, 10)) {
    sessionsDate = new Date().toISOString().slice(0, 10);
    sessionsToday = 0;
  }
  return {
    online,
    displayName: device.displayName || "HOME-PC",
    os: device.os || "Windows PC",
    lastSeen: device.lastSeen,
    agentVersion: device.agentVersion,
    sessionsToday,
  };
}

function getCookie(req, name) {
  const raw = req.headers.cookie || "";
  for (const part of raw.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    if (key === name) return decodeURIComponent(part.slice(index + 1).trim());
  }
  return "";
}

function signOwner(timestamp) {
  return crypto.createHmac("sha256", sessionSecret).update(`owner:${timestamp}`).digest("hex");
}

function ownerCookie() {
  const timestamp = Date.now().toString();
  const value = `${timestamp}.${signOwner(timestamp)}`;
  return `maghrabi_owner=${encodeURIComponent(value)}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=43200`;
}

function clearOwnerCookie() {
  return "maghrabi_owner=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0";
}

function isOwnerAuthenticated(req) {
  if (!ownerPassword) return false;
  const value = getCookie(req, "maghrabi_owner");
  const [timestamp, signature] = value.split(".");
  if (!timestamp || !signature) return false;
  const age = Date.now() - Number(timestamp);
  if (!Number.isFinite(age) || age < 0 || age > 12 * 60 * 60 * 1000) return false;
  return safeEqual(signature, signOwner(timestamp));
}

function requireOwner(req, res) {
  if (!isOwnerAuthenticated(req)) {
    json(res, 401, { ok: false, error: "Owner authentication required" });
    return false;
  }
  return true;
}

function requireAgent(req, res) {
  if (!agentToken) {
    json(res, 503, { ok: false, error: "MAGHRABI_AGENT_TOKEN is not configured on Railway" });
    return false;
  }
  const auth = req.headers.authorization || "";
  const supplied = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!safeEqual(supplied, agentToken)) {
    json(res, 401, { ok: false, error: "Unauthorized agent" });
    return false;
  }
  return true;
}

function clientIp(req) {
  return String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown").split(",")[0].trim();
}

function clearInputQueue() {
  inputQueue = [];
}

function normalizeInputEvent(value) {
  if (!value || typeof value !== "object") return null;
  const type = String(value.type || "");

  if (type === "move") {
    const x = Number(value.x);
    const y = Number(value.y);
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) return null;
    return { type, x: Math.round(x * 100000) / 100000, y: Math.round(y * 100000) / 100000 };
  }

  if (type === "button") {
    const button = String(value.button || "");
    const action = String(value.action || "");
    if (!["left", "middle", "right"].includes(button) || !["down", "up"].includes(action)) return null;
    return { type, button, action };
  }

  if (type === "wheel") {
    const raw = Number(value.delta);
    if (!Number.isFinite(raw)) return null;
    const delta = Math.max(-1200, Math.min(1200, Math.trunc(raw)));
    if (!delta) return null;
    return { type, delta };
  }

  if (type === "key") {
    const code = String(value.code || "");
    const action = String(value.action || "");
    if (!code || code.length > 32 || !/^[A-Za-z0-9]+$/.test(code) || !["down", "up"].includes(action)) return null;
    return { type, code, action };
  }

  if (type === "release") return { type };
  return null;
}

function enqueueInputEvents(events) {
  for (const raw of events) {
    const event = normalizeInputEvent(raw);
    if (!event) continue;
    inputSeq += 1;
    inputQueue.push({ seq: inputSeq, ...event, createdAt: Date.now() });
  }

  if (inputQueue.length > 300) inputQueue = inputQueue.slice(-300);
  const cutoff = Date.now() - 30_000;
  inputQueue = inputQueue.filter((item) => item.createdAt >= cutoff);
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
      "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
      "Content-Security-Policy": "default-src 'self'; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'",
    });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  if (req.method === "GET" && url.pathname === "/api/health") {
    return json(res, 200, {
      ok: true,
      service: "MAGHRABI Remote",
      agentConfigured: Boolean(agentToken),
      ownerConfigured: Boolean(ownerPassword),
      remoteControl: "V2.2",
    });
  }

  if (req.method === "GET" && url.pathname === "/api/auth/status") {
    return json(res, 200, {
      configured: Boolean(ownerPassword),
      authenticated: isOwnerAuthenticated(req),
    });
  }

  if (req.method === "POST" && url.pathname === "/api/auth/login") {
    if (!ownerPassword) return json(res, 503, { ok: false, error: "Owner password is not configured" });
    const ip = clientIp(req);
    const current = failedLogins.get(ip) || { count: 0, since: Date.now() };
    if (Date.now() - current.since > 15 * 60 * 1000) {
      current.count = 0;
      current.since = Date.now();
    }
    if (current.count >= 8) return json(res, 429, { ok: false, error: "Too many login attempts" });

    try {
      const raw = await readBody(req, 8 * 1024);
      const payload = JSON.parse(raw || "{}");
      if (!safeEqual(String(payload.password || ""), ownerPassword)) {
        current.count += 1;
        failedLogins.set(ip, current);
        await new Promise((resolve) => setTimeout(resolve, 400));
        return json(res, 401, { ok: false, error: "Invalid password" });
      }
      failedLogins.delete(ip);
      return json(res, 200, { ok: true }, { "Set-Cookie": ownerCookie() });
    } catch {
      return json(res, 400, { ok: false, error: "Invalid login payload" });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/auth/logout") {
    viewerActiveUntil = 0;
    clearInputQueue();
    return json(res, 200, { ok: true }, { "Set-Cookie": clearOwnerCookie() });
  }

  if (req.method === "GET" && url.pathname === "/api/device-status") {
    if (!requireOwner(req, res)) return;
    return json(res, 200, publicStatus());
  }

  if (req.method === "POST" && url.pathname === "/api/agent/heartbeat") {
    if (!requireAgent(req, res)) return;
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

  if (req.method === "GET" && url.pathname === "/api/agent/session-state") {
    if (!requireAgent(req, res)) return;
    const active = Date.now() < viewerActiveUntil;
    return json(res, 200, {
      screenRequested: active,
      controlRequested: active,
      captureIntervalMs: 1200,
    });
  }

  if (req.method === "GET" && url.pathname === "/api/agent/commands") {
    if (!requireAgent(req, res)) return;
    const active = Date.now() < viewerActiveUntil;
    const requestedAfter = Math.max(0, Number(url.searchParams.get("after") || 0) || 0);
    const after = requestedAfter > inputSeq ? 0 : requestedAfter;

    if (!active) {
      clearInputQueue();
      return json(res, 200, { active: false, controlRequested: false, latestSeq: inputSeq, commands: [] });
    }

    if (after > 0) inputQueue = inputQueue.filter((item) => item.seq > after);
    const commands = inputQueue.filter((item) => item.seq > after).slice(0, 64).map(({ createdAt, ...item }) => item);
    return json(res, 200, {
      active: true,
      controlRequested: true,
      latestSeq: inputSeq,
      commands,
    });
  }

  if (req.method === "POST" && url.pathname === "/api/agent/frame") {
    if (!requireAgent(req, res)) return;
    if (Date.now() >= viewerActiveUntil) return json(res, 409, { ok: false, error: "No active viewer session" });
    if (!String(req.headers["content-type"] || "").toLowerCase().startsWith("image/jpeg")) {
      return json(res, 415, { ok: false, error: "JPEG frame required" });
    }
    try {
      const frame = await readBinary(req);
      if (!frame.length) return json(res, 400, { ok: false, error: "Empty frame" });
      latestFrame = frame;
      latestFrameAt = new Date().toISOString();
      return json(res, 200, { ok: true, frameAt: latestFrameAt });
    } catch {
      return json(res, 413, { ok: false, error: "Frame too large" });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/session/start") {
    if (!requireOwner(req, res)) return;
    const status = publicStatus();
    if (!status.online) return json(res, 409, { ok: false, error: "HOME-PC is offline" });
    viewerActiveUntil = Date.now() + 25_000;
    latestFrame = null;
    latestFrameAt = null;
    clearInputQueue();
    sessionsToday += 1;
    return json(res, 200, { ok: true, mode: "control", expiresInSeconds: 25 });
  }

  if (req.method === "POST" && url.pathname === "/api/session/keepalive") {
    if (!requireOwner(req, res)) return;
    viewerActiveUntil = Date.now() + 25_000;
    return json(res, 200, { ok: true });
  }

  if (req.method === "POST" && url.pathname === "/api/session/input") {
    if (!requireOwner(req, res)) return;
    if (Date.now() >= viewerActiveUntil) return json(res, 409, { ok: false, error: "No active control session" });
    try {
      const raw = await readBody(req, 24 * 1024);
      const payload = JSON.parse(raw || "{}");
      const events = Array.isArray(payload.events) ? payload.events.slice(0, 32) : [];
      if (!events.length) return json(res, 400, { ok: false, error: "No input events" });
      enqueueInputEvents(events);
      viewerActiveUntil = Date.now() + 25_000;
      return json(res, 200, { ok: true, latestSeq: inputSeq });
    } catch {
      return json(res, 400, { ok: false, error: "Invalid input payload" });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/session/stop") {
    if (!requireOwner(req, res)) return;
    viewerActiveUntil = 0;
    latestFrame = null;
    latestFrameAt = null;
    enqueueInputEvents([{ type: "release" }]);
    return json(res, 200, { ok: true });
  }

  if (req.method === "GET" && url.pathname === "/api/session/state") {
    if (!requireOwner(req, res)) return;
    return json(res, 200, {
      active: Date.now() < viewerActiveUntil,
      frameAvailable: Boolean(latestFrame),
      frameAt: latestFrameAt,
      mode: "control",
      inputQueueDepth: inputQueue.length,
    });
  }

  if (req.method === "GET" && url.pathname === "/api/session/frame") {
    if (!requireOwner(req, res)) return;
    if (!latestFrame) {
      res.writeHead(204, { "Cache-Control": "no-store" });
      return res.end();
    }
    res.writeHead(200, {
      "Content-Type": "image/jpeg",
      "Content-Length": latestFrame.length,
      "Cache-Control": "no-store, no-cache, must-revalidate",
      "X-Content-Type-Options": "nosniff",
    });
    return res.end(latestFrame);
  }

  if (url.pathname.startsWith("/api/")) {
    return json(res, 404, { ok: false, error: "Not found" });
  }

  serveStatic(req, res);
});

server.listen(port, "0.0.0.0", () => {
  console.log(`MAGHRABI Remote listening on 0.0.0.0:${port}`);
  console.log(`Agent authentication configured: ${Boolean(agentToken)}`);
  console.log(`Owner authentication configured: ${Boolean(ownerPassword)}`);
  console.log("Remote input protocol: V2.2");
});
