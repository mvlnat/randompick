import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";

import { createAppServer } from "./server.js";
import {
  exportToSwiftTree,
  normalizeImportedTree,
  validateInternalTree,
} from "../shared/tree.js";

function createFixtureRoots() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "randompick-server-"));
  const publicRoot = path.join(tempDir, "public");
  const sharedRoot = path.join(tempDir, "shared");

  fs.mkdirSync(publicRoot, { recursive: true });
  fs.mkdirSync(sharedRoot, { recursive: true });

  fs.writeFileSync(
    path.join(publicRoot, "index.html"),
    "<!doctype html><html><body><div id=\"app\">RandomPick</div></body></html>",
  );
  fs.writeFileSync(path.join(publicRoot, "app.js"), "console.log('ok');");
  fs.writeFileSync(path.join(sharedRoot, "tree.js"), "export const ok = true;");
  fs.writeFileSync(path.join(tempDir, "secret.txt"), "secret");
  fs.symlinkSync(path.join(tempDir, "secret.txt"), path.join(publicRoot, "leak.txt"));
  fs.symlinkSync(path.join(tempDir, "secret.txt"), path.join(sharedRoot, "leak.txt"));

  return {
    publicRoot,
    sharedRoot,
    cleanup() {
      fs.rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

function createStore(overrides = {}) {
  let state = {
    version: 0,
    tree: [],
    updatedAt: "2026-01-01T00:00:00.000Z",
  };

  return {
    getState() {
      return overrides.getState ? overrides.getState() : state;
    },
    saveState(expectedVersion, tree) {
      if (overrides.saveState) {
        return overrides.saveState(expectedVersion, tree);
      }

      const nextTree = validateInternalTree(tree);
      state = {
        version: expectedVersion + 1,
        tree: nextTree,
        updatedAt: "2026-01-01T00:00:00.000Z",
      };

      return {
        ok: true,
        state,
      };
    },
    importState(mode, payload) {
      if (overrides.importState) {
        return overrides.importState(mode, payload);
      }

      const importedTree = normalizeImportedTree(payload);
      state = {
        version: state.version + 1,
        tree: mode === "merge" ? [...state.tree, ...importedTree] : importedTree,
        updatedAt: "2026-01-01T00:00:00.000Z",
      };

      return {
        ok: true,
        state,
      };
    },
    exportState() {
      return overrides.exportState ? overrides.exportState() : exportToSwiftTree(state.tree);
    },
  };
}

async function withServer(storeOverrides, run) {
  const fixtures = createFixtureRoots();
  const server = createAppServer({
    store: createStore(storeOverrides),
    publicRoot: fixtures.publicRoot,
    sharedRoot: fixtures.sharedRoot,
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    await run(baseUrl);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fixtures.cleanup();
  }
}

function rawHttpRequest(baseUrl, method, target) {
  const url = new URL(baseUrl);
  const hostHeader = `${url.hostname}:${url.port}`;

  return new Promise((resolve, reject) => {
    const socket = net.createConnection({
      host: url.hostname,
      port: Number(url.port),
    });
    const chunks = [];

    socket.setTimeout(2_000, () => {
      socket.destroy(new Error("Timed out waiting for raw HTTP response."));
    });
    socket.on("connect", () => {
      socket.write(
        `${method} ${target} HTTP/1.1\r\nHost: ${hostHeader}\r\nConnection: close\r\n\r\n`,
      );
    });
    socket.on("data", (chunk) => {
      chunks.push(chunk);
    });
    socket.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    socket.on("error", reject);
  });
}

function splitRawHttpResponse(rawResponse) {
  const separatorIndex = rawResponse.indexOf("\r\n\r\n");
  assert.notEqual(separatorIndex, -1);

  return {
    headers: rawResponse.slice(0, separatorIndex),
    body: rawResponse.slice(separatorIndex + 4),
  };
}

test("server serves HTML with baseline security headers", async () => {
  await withServer({}, async (baseUrl) => {
    const response = await fetch(baseUrl);
    const body = await response.text();

    assert.equal(response.status, 200);
    assert.match(body, /RandomPick/);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("x-frame-options"), "DENY");
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
    assert.match(response.headers.get("content-security-policy") || "", /default-src 'self'/);
  });
});

test("server disables caching for app shell assets", async () => {
  await withServer({}, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/app.js`);
    const body = await response.text();

    assert.equal(response.status, 200);
    assert.match(body, /console\.log\('ok'\)/);
    assert.equal(response.headers.get("cache-control"), "no-store");
  });
});

test("server sends headers without bodies for HEAD static requests", async () => {
  await withServer({}, async (baseUrl) => {
    const { headers, body } = splitRawHttpResponse(
      await rawHttpRequest(baseUrl, "HEAD", "/app.js"),
    );

    assert.match(headers, /^HTTP\/1\.1 200 OK/);
    assert.match(
      headers,
      new RegExp(`Content-Length: ${Buffer.byteLength("console.log('ok');")}`),
    );
    assert.equal(body, "");
  });
});

test("server returns 404 for missing static asset paths", async () => {
  await withServer({}, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/missing.js`);
    const payload = await response.json();

    assert.equal(response.status, 404);
    assert.equal(payload.error, "Not found");
  });
});

test("server rejects non-GET static route methods", async () => {
  await withServer({}, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/app.js`, {
      method: "POST",
    });
    const payload = await response.json();

    assert.equal(response.status, 405);
    assert.equal(response.headers.get("allow"), "GET, HEAD");
    assert.equal(payload.error, "Method not allowed");
  });
});

test("server exposes the local SortableJS vendor module", async () => {
  await withServer({}, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/vendor/sortablejs.js`);
    const body = await response.text();

    assert.equal(response.status, 200);
    assert.match(body, /Sortable 1\.15\.7/);
    assert.equal(response.headers.get("content-type"), "text/javascript; charset=utf-8");
  });
});

test("server sends baseline security headers on JSON exports", async () => {
  await withServer({}, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/export`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(body, []);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("x-frame-options"), "DENY");
    assert.match(response.headers.get("content-security-policy") || "", /default-src 'self'/);
    assert.equal(
      response.headers.get("content-disposition"),
      'attachment; filename="randompick-export.json"',
    );
  });
});

test("server rejects shared path traversal attempts", async () => {
  await withServer({}, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/shared/..%2Fserver.js`);
    const payload = await response.json();

    assert.equal(response.status, 400);
    assert.equal(payload.error, "Invalid path");
  });
});

test("server rejects symlink escapes from static roots", async () => {
  await withServer({}, async (baseUrl) => {
    const publicResponse = await fetch(`${baseUrl}/leak.txt`);
    const publicPayload = await publicResponse.json();

    assert.equal(publicResponse.status, 404);
    assert.equal(publicPayload.error, "Not found");

    const sharedResponse = await fetch(`${baseUrl}/shared/leak.txt`);
    const sharedPayload = await sharedResponse.json();

    assert.equal(sharedResponse.status, 404);
    assert.equal(sharedPayload.error, "Not found");
  });
});

test("server rejects app shell symlink escapes", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "randompick-server-"));
  const publicRoot = path.join(tempDir, "public");
  const sharedRoot = path.join(tempDir, "shared");
  const secretPath = path.join(tempDir, "secret.html");

  fs.mkdirSync(publicRoot, { recursive: true });
  fs.mkdirSync(sharedRoot, { recursive: true });
  fs.writeFileSync(secretPath, "<!doctype html><p>secret</p>");
  fs.symlinkSync(secretPath, path.join(publicRoot, "index.html"));

  const server = createAppServer({
    store: createStore(),
    publicRoot,
    sharedRoot,
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const address = server.address();
    const response = await fetch(`http://127.0.0.1:${address.port}/`);
    const payload = await response.json();

    assert.equal(response.status, 404);
    assert.equal(payload.error, "Not found");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("server returns 400 for invalid JSON request bodies", async () => {
  await withServer({}, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/state`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
      },
      body: "{invalid",
    });
    const payload = await response.json();

    assert.equal(response.status, 400);
    assert.equal(payload.error, "Invalid JSON body.");
  });
});

test("server rejects unsupported methods on known API routes", async () => {
  await withServer({}, async (baseUrl) => {
    const stateResponse = await fetch(`${baseUrl}/api/state`, {
      method: "POST",
    });
    const statePayload = await stateResponse.json();

    assert.equal(stateResponse.status, 405);
    assert.equal(stateResponse.headers.get("allow"), "GET, HEAD, PUT");
    assert.equal(statePayload.error, "Method not allowed");

    const importResponse = await fetch(`${baseUrl}/api/import`, {
      method: "GET",
    });
    const importPayload = await importResponse.json();

    assert.equal(importResponse.status, 405);
    assert.equal(importResponse.headers.get("allow"), "POST");
    assert.equal(importPayload.error, "Method not allowed");

    const exportResponse = await fetch(`${baseUrl}/api/export`, {
      method: "POST",
    });
    const exportPayload = await exportResponse.json();

    assert.equal(exportResponse.status, 405);
    assert.equal(exportResponse.headers.get("allow"), "GET, HEAD");
    assert.equal(exportPayload.error, "Method not allowed");
  });
});

test("server sends headers without bodies for HEAD API requests", async () => {
  await withServer({}, async (baseUrl) => {
    const expectedBody = JSON.stringify({
      version: 0,
      tree: [],
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const { headers, body } = splitRawHttpResponse(
      await rawHttpRequest(baseUrl, "HEAD", "/api/state"),
    );

    assert.match(headers, /^HTTP\/1\.1 200 OK/);
    assert.match(headers, new RegExp(`Content-Length: ${Buffer.byteLength(expectedBody)}`));
    assert.equal(body, "");
  });
});

test("server returns 400 for invalid state versions", async () => {
  await withServer({}, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/state`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        version: "latest",
        tree: [],
      }),
    });
    const payload = await response.json();

    assert.equal(response.status, 400);
    assert.equal(payload.error, "Expected a non-negative safe integer version.");
  });
});

test("server returns 400 for unsafe integer state versions", async () => {
  await withServer({}, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/state`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        version: Number.MAX_SAFE_INTEGER + 1,
        tree: [],
      }),
    });
    const payload = await response.json();

    assert.equal(response.status, 400);
    assert.equal(payload.error, "Expected a non-negative safe integer version.");
  });
});

test("server returns 400 for invalid state tree payloads", async () => {
  await withServer({}, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/state`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        version: 0,
        tree: {},
      }),
    });
    const payload = await response.json();

    assert.equal(response.status, 400);
    assert.equal(payload.error, "Tree must be an array of nodes.");
  });
});

test("server returns 400 for invalid node kind values", async () => {
  await withServer({}, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/state`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        version: 0,
        tree: [
          {
            id: "bad",
            title: "Bad",
            kind: "folder",
            isExpanded: true,
            children: [],
          },
        ],
      }),
    });
    const payload = await response.json();

    assert.equal(response.status, 400);
    assert.equal(payload.error, "Node kind must be 'list' or 'item'.");
  });
});

test("server returns 400 for invalid node weights", async () => {
  await withServer({}, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/state`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        version: 0,
        tree: [
          {
            id: "bad",
            title: "Bad",
            weight: 100,
            kind: "item",
            isExpanded: false,
            children: [],
          },
        ],
      }),
    });
    const payload = await response.json();

    assert.equal(response.status, 400);
    assert.equal(payload.error, "Node weight must be an integer from 1 to 99.");
  });
});

test("server returns 400 for invalid import nodes", async () => {
  await withServer({}, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/import`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify([42]),
    });
    const payload = await response.json();

    assert.equal(response.status, 400);
    assert.equal(payload.error, "Each node must be an object.");
  });
});

test("server returns 400 for invalid import children values", async () => {
  await withServer({}, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/import`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify([
        {
          id: "bad",
          title: "Bad",
          children: {},
        },
      ]),
    });
    const payload = await response.json();

    assert.equal(response.status, 400);
    assert.equal(payload.error, "Node children must be an array when present.");
  });
});

test("server returns 400 for invalid import modes", async () => {
  await withServer({}, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/import?mode=append`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify([]),
    });
    const payload = await response.json();

    assert.equal(response.status, 400);
    assert.equal(payload.error, "Import mode must be 'merge' or 'replace'.");
  });
});

test("server returns 400 for empty explicit import modes", async () => {
  await withServer({}, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/import?mode=`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify([]),
    });
    const payload = await response.json();

    assert.equal(response.status, 400);
    assert.equal(payload.error, "Import mode must be 'merge' or 'replace'.");
  });
});

test("server returns 413 for oversized request bodies", async () => {
  await withServer({}, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/state`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
      },
      body: `"${"x".repeat(5_000_001)}"`,
    });
    const payload = await response.json();

    assert.equal(response.status, 413);
    assert.equal(payload.error, "Request body too large.");
  });
});

test("server hides internal errors behind a generic 500", async () => {
  const originalConsoleError = console.error;
  console.error = () => {};

  try {
    await withServer({
      saveState() {
        throw new Error("secret database issue");
      },
    }, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/state`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          version: 0,
          tree: [],
        }),
      });
      const payload = await response.json();

      assert.equal(response.status, 500);
      assert.equal(payload.error, "Unexpected server error");
    });
  } finally {
    console.error = originalConsoleError;
  }
});
