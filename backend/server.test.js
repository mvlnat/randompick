import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";

import { createAppServer } from "./server.js";

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

      state = {
        version: expectedVersion + 1,
        tree,
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

      state = {
        version: state.version + 1,
        tree: mode === "merge" ? [...state.tree, ...payload] : payload,
        updatedAt: "2026-01-01T00:00:00.000Z",
      };

      return {
        ok: true,
        state,
      };
    },
    exportState() {
      return overrides.exportState ? overrides.exportState() : state.tree;
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

test("server exposes the local SortableJS vendor module", async () => {
  await withServer({}, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/vendor/sortablejs.js`);
    const body = await response.text();

    assert.equal(response.status, 200);
    assert.match(body, /Sortable 1\.15\.7/);
    assert.equal(response.headers.get("content-type"), "text/javascript; charset=utf-8");
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
