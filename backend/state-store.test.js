import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { StateStore } from "./state-store.js";

function createStore() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "randompick-store-"));
  const databasePath = path.join(tempDir, "state.db");
  const store = new StateStore(databasePath);

  return {
    store,
    cleanup() {
      store.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

test("StateStore starts empty", () => {
  const { store, cleanup } = createStore();

  assert.deepEqual(store.getState().tree, []);
  assert.equal(store.getState().version, 0);

  cleanup();
});

test("StateStore increments version on save", () => {
  const { store, cleanup } = createStore();

  const result = store.saveState(0, [
    {
      id: "root",
      title: "Default",
      kind: "list",
      isExpanded: true,
      children: [],
    },
  ]);

  assert.equal(result.ok, true);
  assert.equal(result.state.version, 1);
  assert.equal(store.getState().version, 1);

  cleanup();
});

test("StateStore reports conflicts with current state", () => {
  const { store, cleanup } = createStore();

  store.saveState(0, [
    {
      id: "root",
      title: "Default",
      kind: "list",
      isExpanded: true,
      children: [],
    },
  ]);

  const result = store.saveState(0, []);

  assert.equal(result.ok, false);
  assert.equal(result.reason, "conflict");
  assert.equal(result.state.version, 1);

  cleanup();
});

test("StateStore rejects invalid expected versions", () => {
  const { store, cleanup } = createStore();

  assert.throws(
    () => store.saveState("0", []),
    /Expected version must be a non-negative safe integer\./,
  );
  assert.throws(
    () => store.saveState(Number.MAX_SAFE_INTEGER + 1, []),
    /Expected version must be a non-negative safe integer\./,
  );

  cleanup();
});

test("StateStore rejects invalid stored versions", () => {
  const { store, cleanup } = createStore();

  store.db.prepare(`
    INSERT INTO app_state (id, version, tree_json, updated_at)
    VALUES (1, -1, '[]', '2026-01-01T00:00:00.000Z')
  `).run();

  assert.throws(
    () => store.getState(),
    /Stored state version must be a non-negative safe integer\./,
  );

  cleanup();
});

test("StateStore refuses unsafe version increments", () => {
  const { store, cleanup } = createStore();

  store.db.prepare(`
    INSERT INTO app_state (id, version, tree_json, updated_at)
    VALUES (1, $version, '[]', '2026-01-01T00:00:00.000Z')
  `).run({
    $version: Number.MAX_SAFE_INTEGER,
  });

  assert.throws(
    () => store.saveState(Number.MAX_SAFE_INTEGER, []),
    /State version is too large to increment safely\./,
  );

  cleanup();
});

test("StateStore persists normalized repaired state on read", () => {
  const { store, cleanup } = createStore();
  const duplicatedTree = [
    {
      id: "duplicate",
      title: "A",
      kind: "list",
      isExpanded: true,
      children: [
        {
          id: "duplicate",
          title: "B",
          kind: "item",
          isExpanded: false,
          children: [],
        },
      ],
    },
  ];

  store.db.prepare(`
    INSERT INTO app_state (id, version, tree_json, updated_at)
    VALUES (1, 1, $tree_json, '2026-01-01T00:00:00.000Z')
  `).run({
    $tree_json: JSON.stringify(duplicatedTree),
  });

  const firstRead = store.getState();
  const secondRead = store.getState();

  assert.equal(firstRead.tree[0].id, "duplicate");
  assert.notEqual(firstRead.tree[0].children[0].id, "duplicate");
  assert.deepEqual(secondRead.tree, firstRead.tree);

  cleanup();
});

test("StateStore importState merges imported roots", () => {
  const { store, cleanup } = createStore();

  store.saveState(0, [
    {
      id: "existing",
      title: "Existing",
      kind: "list",
      isExpanded: true,
      children: [],
    },
  ]);

  const result = store.importState("merge", [
    {
      id: "imported",
      title: "Imported",
      isExpanded: true,
      children: [],
    },
  ]);

  assert.equal(result.ok, true);
  assert.equal(result.state.tree.length, 2);

  cleanup();
});

test("StateStore rejects invalid import modes", () => {
  const { store, cleanup } = createStore();

  assert.throws(
    () => store.importState("append", []),
    /Import mode must be 'merge' or 'replace'\./,
  );

  cleanup();
});
