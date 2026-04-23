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

