/**
 * Production front door for the Polymer console (Docker image only).
 *
 * The stock Next standalone server (`server.js`) cannot proxy WebSocket
 * upgrades, so browsers had nowhere to open `/api/events`: the socket
 * hung and the Fleet page sat at "Connecting…". This wrapper listens on
 * PORT, forwards `/api/events` upgrades to the backend (with the
 * browser-facing session cookie translated back to the `__Host-` name
 * the backend expects), and reverse-proxies everything else — HTTP and
 * any other upgrade — to the stock server on an internal port.
 *
 * Plain node, no dependencies. `next start` / `next dev` are untouched.
 */
import { createServer, request as httpRequest } from "node:http";
import { connect } from "node:net";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PUBLIC_PORT = parseInt(process.env.PORT ?? "3000", 10);
const INTERNAL_PORT = parseInt(process.env.NEXT_PORT ?? "3001", 10);
const INTERNAL_HOST = "127.0.0.1";
const BACKEND = new URL(process.env.POLYMER_API_URL ?? "http://server:8080");
const BACKEND_HOST = BACKEND.hostname;
const BACKEND_PORT = parseInt(
  BACKEND.port || (BACKEND.protocol === "https:" ? "443" : "80"),
  10,
);
const HERE = path.dirname(fileURLToPath(import.meta.url));

function sessionTokenFromCookie(header) {
  if (!header) return undefined;
  for (const pair of header.split(";")) {
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    const name = pair.slice(0, eq).trim();
    if (name === "__Host-polymer_admin" || name === "polymer_admin") {
      return pair.slice(eq + 1).trim();
    }
  }
  return undefined;
}

/** Forward an /api/events upgrade to the backend with backend credentials. */
function proxyEventsUpgrade(req, socket, head) {
  const token = sessionTokenFromCookie(req.headers.cookie);
  const upstream = connect(BACKEND_PORT, BACKEND_HOST, () => {
    const lines = [`GET ${req.url} HTTP/1.1`];
    for (const [name, value] of Object.entries(req.headers)) {
      if (name === "cookie") continue;
      if (name === "connection" || name === "upgrade") continue;
      if (Array.isArray(value)) {
        for (const v of value) lines.push(`${name}: ${v}`);
      } else if (value !== undefined) {
        lines.push(`${name}: ${value}`);
      }
    }
    // The browser's Host header passes through untouched, so the
    // backend same-origin check (Origin host === Host) still passes.
    if (token !== undefined) {
      lines.push(`Cookie: __Host-polymer_admin=${token}`);
    }
    lines.push("Connection: Upgrade", "Upgrade: websocket", "", "");
    upstream.write(lines.join("\r\n"));
    if (head.length > 0) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  const destroy = () => {
    try {
      socket.destroy();
    } catch {
      // Socket already gone; upstream cleanup below covers the rest.
    }
    try {
      upstream.destroy();
    } catch {
      // Upstream already gone; nothing left to close.
    }
  };
  upstream.on("error", destroy);
  socket.on("error", destroy);
}

/** Reverse-proxy plain HTTP (and non-events upgrades) to the Next server. */
function proxyHttp(req, res) {
  const init = {
    host: INTERNAL_HOST,
    port: INTERNAL_PORT,
    method: req.method,
    path: req.url,
    headers: req.headers,
  };
  const upstream = httpRequest(init, (upRes) => {
    res.writeHead(upRes.statusCode ?? 502, upRes.headers);
    upRes.pipe(res);
  });
  upstream.on("error", () => {
    if (!res.headersSent) res.writeHead(502);
    res.end("console starting");
  });
  req.pipe(upstream);
}

function start() {
  const child = spawn("node", [path.join(HERE, "server.js")], {
    env: { ...process.env, PORT: String(INTERNAL_PORT) },
    stdio: "inherit",
  });
  child.on("exit", (code) => process.exit(code ?? 1));

  const server = createServer(proxyHttp);
  server.on("upgrade", (req, socket, head) => {
    const url = req.url ?? "";
    if (url === "/api/events" || url.startsWith("/api/events?")) {
      proxyEventsUpgrade(req, socket, head);
      return;
    }
    // Anything else: raw TCP forward to the Next server.
    const upstream = connect(INTERNAL_PORT, INTERNAL_HOST, () => {
      const lines = [`${req.method} ${url} HTTP/1.1`];
      for (const [name, value] of Object.entries(req.headers)) {
        if (Array.isArray(value)) {
          for (const v of value) lines.push(`${name}: ${v}`);
        } else if (value !== undefined) {
          lines.push(`${name}: ${value}`);
        }
      }
      lines.push("", "");
      upstream.write(lines.join("\r\n"));
      if (head.length > 0) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    upstream.on("error", () => {
      try {
        socket.destroy();
      } catch {
        // Client already gone; nothing left to close.
      }
    });
  });
  server.listen(PUBLIC_PORT, process.env.HOSTNAME ?? "0.0.0.0", () => {
    console.log(
      `polymer console on :${PUBLIC_PORT} (events → ${BACKEND.host})`,
    );
  });

  const shutdown = () => {
    child.kill("SIGTERM");
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

start();
