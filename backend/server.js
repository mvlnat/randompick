import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";

import { StateStore } from "./state-store.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const defaultPublicRoot = path.join(__dirname, "public");
const defaultSharedRoot = path.join(projectRoot, "shared");

function sendJson(response, statusCode, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  response.end(body);
}

function sendText(response, statusCode, body, contentType) {
  response.writeHead(statusCode, {
    "Content-Type": contentType,
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  response.end(body);
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";

    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;

      if (body.length > 5_000_000) {
        reject(new Error("Request body too large."));
      }
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

function parseJsonBody(body) {
  if (!body || body.trim().length === 0) {
    return null;
  }

  return JSON.parse(body);
}

function getContentType(filePath) {
  const extension = path.extname(filePath).toLowerCase();

  switch (extension) {
    case ".css":
      return "text/css; charset=utf-8";
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    default:
      return "application/octet-stream";
  }
}

function serveFile(response, filePath) {
  try {
    const body = fs.readFileSync(filePath);
    response.writeHead(200, {
      "Content-Type": getContentType(filePath),
      "Content-Length": body.length,
      "Cache-Control": filePath.endsWith(".html") ? "no-store" : "public, max-age=3600",
    });
    response.end(body);
  } catch {
    sendJson(response, 404, { error: "Not found" });
  }
}

async function handleApi(store, request, response, url) {
  if (request.method === "GET" && url.pathname === "/api/healthz") {
    sendJson(response, 200, { status: "ok" });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/state") {
    sendJson(response, 200, store.getState());
    return;
  }

  if (request.method === "PUT" && url.pathname === "/api/state") {
    const body = parseJsonBody(await readRequestBody(request));

    if (!body || typeof body !== "object") {
      sendJson(response, 400, { error: "Expected a JSON object body." });
      return;
    }

    const result = store.saveState(Number(body.version ?? -1), body.tree);
    if (!result.ok) {
      sendJson(response, 409, {
        error: "Save conflict",
        state: result.state,
      });
      return;
    }

    sendJson(response, 200, result.state);
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/import") {
    const mode = url.searchParams.get("mode") === "merge" ? "merge" : "replace";
    const body = parseJsonBody(await readRequestBody(request));
    const payload = Array.isArray(body) ? body : body?.tree;

    if (!Array.isArray(payload)) {
      sendJson(response, 400, { error: "Import body must be a JSON array or { tree: [] }." });
      return;
    }

    const result = store.importState(mode, payload);
    sendJson(response, 200, result.state);
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/export") {
    const body = JSON.stringify(store.exportState(), null, 2);
    response.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": 'attachment; filename="randompick-export.json"',
      "Content-Length": Buffer.byteLength(body),
      "Cache-Control": "no-store",
    });
    response.end(body);
    return;
  }

  sendJson(response, 404, { error: "Not found" });
}

export function createAppServer({
  store,
  publicRoot = defaultPublicRoot,
  sharedRoot = defaultSharedRoot,
} = {}) {
  if (!store) {
    throw new Error("createAppServer requires a StateStore instance.");
  }

  return http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);

      if (url.pathname.startsWith("/api/")) {
        await handleApi(store, request, response, url);
        return;
      }

      if (url.pathname.startsWith("/shared/")) {
        const requested = path.normalize(url.pathname.replace(/^\/shared\//, ""));
        if (requested.startsWith("..")) {
          sendJson(response, 400, { error: "Invalid path" });
          return;
        }

        serveFile(response, path.join(sharedRoot, requested));
        return;
      }

      const requestedPath = url.pathname === "/" ? "/index.html" : url.pathname;
      const filePath = path.join(publicRoot, path.normalize(requestedPath));

      if (!filePath.startsWith(publicRoot)) {
        sendJson(response, 400, { error: "Invalid path" });
        return;
      }

      if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        serveFile(response, filePath);
        return;
      }

      serveFile(response, path.join(publicRoot, "index.html"));
    } catch (error) {
      sendJson(response, 500, {
        error: error instanceof Error ? error.message : "Unexpected server error",
      });
    }
  });
}

export function startServer({
  host = process.env.HOST || "127.0.0.1",
  port = Number(process.env.PORT || 8080),
  databasePath = process.env.DATABASE_PATH || path.join(projectRoot, "data", "randompick.db"),
} = {}) {
  const store = new StateStore(databasePath);
  const server = createAppServer({ store });

  server.listen(port, host, () => {
    console.log(`RandomPick listening on http://${host}:${port}`);
  });

  function shutdown() {
    server.close(() => {
      store.close();
      process.exit(0);
    });
  }

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  return server;
}

if (import.meta.main) {
  startServer();
}
