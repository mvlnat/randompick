import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  exportToSwiftTree,
  mergeTrees,
  normalizeImportedTree,
  validateInternalTree,
} from "../shared/tree.js";

function ensureParentDirectory(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function nowIso() {
  return new Date().toISOString();
}

function validateVersion(version, message) {
  if (!Number.isSafeInteger(version) || version < 0) {
    throw new Error(message);
  }

  return version;
}

export class StateStore {
  constructor(databasePath) {
    ensureParentDirectory(databasePath);
    this.db = new DatabaseSync(databasePath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS app_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        version INTEGER NOT NULL,
        tree_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS app_backups (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT NOT NULL,
        tree_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
  }

  getState() {
    const row = this.db.prepare(`
      SELECT version, tree_json, updated_at
      FROM app_state
      WHERE id = 1
    `).get();

    if (!row) {
      return {
        version: 0,
        tree: [],
        updatedAt: nowIso(),
      };
    }

    const tree = validateInternalTree(JSON.parse(row.tree_json));
    const treeJson = JSON.stringify(tree);
    if (treeJson !== row.tree_json) {
      this.db.prepare(`
        UPDATE app_state
        SET tree_json = $tree_json
        WHERE id = 1
      `).run({
        $tree_json: treeJson,
      });
    }

    const version = validateVersion(
      row.version,
      "Stored state version must be a non-negative safe integer.",
    );

    return {
      version,
      tree,
      updatedAt: row.updated_at,
    };
  }

  saveState(expectedVersion, tree) {
    validateVersion(expectedVersion, "Expected version must be a non-negative safe integer.");

    const current = this.getState();
    if (current.version !== expectedVersion) {
      return {
        ok: false,
        reason: "conflict",
        state: current,
      };
    }

    if (current.version >= Number.MAX_SAFE_INTEGER) {
      throw new Error("State version is too large to increment safely.");
    }

    const nextState = {
      version: current.version + 1,
      tree: validateInternalTree(tree),
      updatedAt: nowIso(),
    };

    this.db.prepare(`
      INSERT INTO app_state (id, version, tree_json, updated_at)
      VALUES (1, $version, $tree_json, $updated_at)
      ON CONFLICT(id) DO UPDATE SET
        version = excluded.version,
        tree_json = excluded.tree_json,
        updated_at = excluded.updated_at
    `).run({
      $version: nextState.version,
      $tree_json: JSON.stringify(nextState.tree),
      $updated_at: nextState.updatedAt,
    });

    return {
      ok: true,
      state: nextState,
    };
  }

  createBackup(source) {
    const current = this.getState();
    this.db.prepare(`
      INSERT INTO app_backups (source, tree_json, created_at)
      VALUES ($source, $tree_json, $created_at)
    `).run({
      $source: source,
      $tree_json: JSON.stringify(current.tree),
      $created_at: nowIso(),
    });
  }

  importState(mode, payload) {
    if (!["merge", "replace"].includes(mode)) {
      throw new Error("Import mode must be 'merge' or 'replace'.");
    }

    const importedTree = normalizeImportedTree(payload);
    const current = this.getState();

    const nextTree =
      mode === "merge" ? mergeTrees(current.tree, importedTree) : importedTree;

    if (mode === "replace") {
      this.createBackup("replace-import");
    }

    return this.saveState(current.version, nextTree);
  }

  exportState() {
    return exportToSwiftTree(this.getState().tree);
  }

  close() {
    this.db.close();
  }
}
