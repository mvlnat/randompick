import test from "node:test";
import assert from "node:assert/strict";

import {
  addChildNode,
  addRootNode,
  createNode,
  deleteNode,
  duplicateNode,
  exportToSwiftTree,
  findNode,
  MAX_NODE_URL_LENGTH,
  mergeTrees,
  moveNodeRelative,
  moveNodeToParent,
  normalizeImportedTree,
  updateNodeUrl,
  updateNodeWeight,
  validateInternalTree,
} from "./tree.js";

test("normalizeImportedTree keeps empty children arrays as lists", () => {
  const tree = normalizeImportedTree([
    {
      id: "root",
      title: "Default",
      isExpanded: true,
      children: [],
    },
  ]);

  assert.equal(tree[0].kind, "list");
  assert.deepEqual(tree[0].children, []);
});

test("normalizeImportedTree defaults and preserves node weights", () => {
  const tree = normalizeImportedTree([
    {
      id: "root",
      title: "Default",
      isExpanded: true,
      children: [
        {
          id: "plain",
          title: "Plain",
        },
        {
          id: "weighted",
          title: "Weighted",
          weight: 4,
        },
      ],
    },
  ]);

  assert.equal(tree[0].weight, 1);
  assert.equal(tree[0].children[0].weight, 1);
  assert.equal(tree[0].children[1].weight, 4);
});

test("normalizeImportedTree defaults and preserves node URLs", () => {
  const tree = normalizeImportedTree([
    {
      id: "root",
      title: "Default",
      isExpanded: true,
      url: " https://example.com/path ",
      children: [
        {
          id: "plain",
          title: "Plain",
        },
      ],
    },
  ]);

  assert.equal(tree[0].url, "https://example.com/path");
  assert.equal(tree[0].children[0].url, "");
});

test("validateInternalTree rejects invalid node weights", () => {
  assert.throws(
    () => validateInternalTree([
      {
        id: "bad",
        title: "Bad",
        weight: 0,
        kind: "item",
        isExpanded: false,
        children: [],
      },
    ]),
    /Node weight must be an integer from 1 to 99\./,
  );

  assert.throws(
    () => validateInternalTree([
      {
        id: "bad",
        title: "Bad",
        weight: 1.5,
        kind: "item",
        isExpanded: false,
        children: [],
      },
    ]),
    /Node weight must be an integer from 1 to 99\./,
  );
});

test("validateInternalTree rejects invalid node URLs", () => {
  assert.throws(
    () => validateInternalTree([
      {
        id: "bad",
        title: "Bad",
        url: 42,
        kind: "item",
        isExpanded: false,
        children: [],
      },
    ]),
    /Node URL must be a string\./,
  );

  assert.throws(
    () => validateInternalTree([
      {
        id: "bad",
        title: "Bad",
        url: `https://example.com/${"x".repeat(MAX_NODE_URL_LENGTH)}`,
        kind: "item",
        isExpanded: false,
        children: [],
      },
    ]),
    /Node URL must be 2048 characters or fewer\./,
  );
});

test("normalizeImportedTree regenerates duplicate node IDs", () => {
  const tree = normalizeImportedTree([
    {
      id: "duplicate",
      title: "Root",
      isExpanded: true,
      children: [
        {
          id: "duplicate",
          title: "Child",
        },
      ],
    },
    {
      id: "duplicate",
      title: "Sibling",
    },
  ]);

  assert.equal(tree[0].id, "duplicate");
  assert.notEqual(tree[0].children[0].id, "duplicate");
  assert.notEqual(tree[1].id, "duplicate");
  assert.notEqual(tree[0].children[0].id, tree[1].id);
});

test("validateInternalTree rejects invalid explicit node kinds", () => {
  assert.throws(
    () => validateInternalTree([
      {
        id: "bad",
        title: "Bad",
        kind: "folder",
        isExpanded: true,
        children: [],
      },
    ]),
    /Node kind must be 'list' or 'item'\./,
  );

  assert.throws(
    () => validateInternalTree([
      {
        id: "bad",
        title: "Bad",
        kind: 42,
        isExpanded: true,
        children: [],
      },
    ]),
    /Node kind must be 'list' or 'item'\./,
  );
});

test("normalizeImportedTree rejects non-array children values", () => {
  assert.throws(
    () => normalizeImportedTree([
      {
        id: "bad",
        title: "Bad",
        children: {},
      },
    ]),
    /Node children must be an array when present\./,
  );
});

test("addChildNode promotes an item into a list", () => {
  const item = createNode({ title: "Leaf", kind: "item" });
  const child = createNode({ title: "Nested", kind: "item" });
  const tree = addChildNode([item], item.id, child);

  const promoted = findNode(tree, item.id);
  assert.ok(promoted);
  assert.equal(promoted.kind, "list");
  assert.equal(promoted.children.length, 1);
});

test("updateNodeWeight changes a node weight", () => {
  const item = createNode({ title: "Leaf", kind: "item" });
  const tree = updateNodeWeight([item], item.id, 3);

  assert.equal(findNode(tree, item.id).weight, 3);
});

test("updateNodeUrl changes a node URL", () => {
  const item = createNode({ title: "Leaf", kind: "item" });
  const tree = updateNodeUrl([item], item.id, " example.com ");

  assert.equal(findNode(tree, item.id).url, "example.com");
});

test("add helpers regenerate duplicate inserted node IDs", () => {
  const existing = createNode({ title: "Existing", kind: "item" });

  const rootTree = addRootNode([existing], {
    id: existing.id,
    title: "Duplicate Root",
    kind: "item",
  });
  assert.equal(rootTree[0].id, existing.id);
  assert.notEqual(rootTree[1].id, existing.id);

  const childTree = addChildNode([existing], existing.id, {
    id: existing.id,
    title: "Duplicate Child",
    kind: "item",
  });
  const promoted = findNode(childTree, existing.id);
  assert.ok(promoted);
  assert.notEqual(promoted.children[0].id, existing.id);
});

test("addChildNode preserves existing node IDs when inserted child collides with a later node", () => {
  const parent = createNode({ title: "Parent", kind: "list" });
  const later = createNode({ title: "Later", kind: "item" });

  const tree = addChildNode([parent, later], parent.id, {
    id: later.id,
    title: "Child",
    kind: "item",
  });

  const nextParent = findNode(tree, parent.id);
  const nextLater = findNode(tree, later.id);

  assert.ok(nextParent);
  assert.ok(nextLater);
  assert.notEqual(nextParent.children[0].id, later.id);
});

test("mergeTrees regenerates imported IDs that collide with existing IDs", () => {
  const existing = createNode({ title: "Existing", kind: "item" });
  const merged = mergeTrees([existing], [
    {
      id: existing.id,
      title: "Imported",
      kind: "item",
      isExpanded: false,
      children: [],
    },
  ]);

  assert.equal(merged[0].id, existing.id);
  assert.notEqual(merged[1].id, existing.id);
});

test("deleteNode selects the next sibling when the selected node is removed", () => {
  const a = createNode({ title: "A", kind: "item" });
  const b = createNode({ title: "B", kind: "item" });
  const c = createNode({ title: "C", kind: "item" });

  const result = deleteNode([a, b, c], b.id, b.id);

  assert.equal(result.tree.length, 2);
  assert.equal(result.nextSelectedId, c.id);
});

test("duplicateNode inserts a copy after the original with fresh IDs", () => {
  const child = createNode({
    title: "Child",
    kind: "item",
    weight: 2,
    url: "https://child.example",
  });
  const parent = createNode({
    title: "Parent",
    kind: "list",
    weight: 3,
    url: "https://parent.example",
  });
  parent.children.push(child);
  const sibling = createNode({ title: "Sibling", kind: "item" });

  const result = duplicateNode([parent, sibling], parent.id);

  assert.equal(result.tree.length, 3);
  assert.equal(result.tree[0].id, parent.id);
  assert.equal(result.tree[2].id, sibling.id);

  const duplicate = result.tree[1];
  assert.equal(result.duplicatedId, duplicate.id);
  assert.notEqual(duplicate.id, parent.id);
  assert.equal(duplicate.title, "Parent Copy");
  assert.equal(duplicate.kind, "list");
  assert.equal(duplicate.weight, 3);
  assert.equal(duplicate.url, "https://parent.example");
  assert.equal(duplicate.children.length, 1);
  assert.notEqual(duplicate.children[0].id, child.id);
  assert.equal(duplicate.children[0].title, "Child");
  assert.equal(duplicate.children[0].weight, 2);
  assert.equal(duplicate.children[0].url, "https://child.example");
});

test("moveNodeRelative nests into any node and promotes leaf targets", () => {
  const target = createNode({ title: "Target", kind: "list" });
  const drag = createNode({ title: "Drag", kind: "item" });
  const item = createNode({ title: "Leaf", kind: "item" });

  const nestedTree = moveNodeRelative([target, drag], drag.id, target.id, "inside");
  const nestedTarget = findNode(nestedTree, target.id);
  assert.equal(nestedTarget.children[0].id, drag.id);

  const promotedTree = moveNodeRelative([item, drag], drag.id, item.id, "inside");
  const promotedTarget = findNode(promotedTree, item.id);
  assert.equal(promotedTarget.kind, "list");
  assert.equal(promotedTarget.children[0].id, drag.id);
});

test("moveNodeToParent can move nested nodes back to root", () => {
  const child = createNode({ title: "Child", kind: "item" });
  const parent = createNode({ title: "Parent", kind: "list" });
  parent.children.push(child);
  const root = createNode({ title: "Root", kind: "item" });

  const tree = moveNodeToParent([parent, root], child.id, null, 1);

  assert.equal(tree[1].id, child.id);
  assert.equal(findNode(tree, parent.id).children.length, 0);
});

test("exportToSwiftTree removes internal kind fields from items", () => {
  const item = createNode({ title: "Leaf", kind: "item" });
  const exported = exportToSwiftTree([item]);

  assert.deepEqual(exported, [
    {
      id: item.id,
      isExpanded: false,
      title: "Leaf",
    },
  ]);
});

test("exportToSwiftTree includes non-default weights", () => {
  const item = createNode({ title: "Leaf", kind: "item", weight: 3 });
  const exported = exportToSwiftTree([item]);

  assert.deepEqual(exported, [
    {
      id: item.id,
      isExpanded: false,
      title: "Leaf",
      weight: 3,
    },
  ]);
});

test("exportToSwiftTree includes node URLs", () => {
  const item = createNode({
    title: "Leaf",
    kind: "item",
    url: "https://example.com",
  });
  const exported = exportToSwiftTree([item]);

  assert.deepEqual(exported, [
    {
      id: item.id,
      isExpanded: false,
      title: "Leaf",
      url: "https://example.com",
    },
  ]);
});
