import test from "node:test";
import assert from "node:assert/strict";

import {
  addChildNode,
  createNode,
  deleteNode,
  exportToSwiftTree,
  findNode,
  moveNodeRelative,
  moveNodeToParent,
  normalizeImportedTree,
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

test("addChildNode promotes an item into a list", () => {
  const item = createNode({ title: "Leaf", kind: "item" });
  const child = createNode({ title: "Nested", kind: "item" });
  const tree = addChildNode([item], item.id, child);

  const promoted = findNode(tree, item.id);
  assert.ok(promoted);
  assert.equal(promoted.kind, "list");
  assert.equal(promoted.children.length, 1);
});

test("deleteNode selects the next sibling when the selected node is removed", () => {
  const a = createNode({ title: "A", kind: "item" });
  const b = createNode({ title: "B", kind: "item" });
  const c = createNode({ title: "C", kind: "item" });

  const result = deleteNode([a, b, c], b.id, b.id);

  assert.equal(result.tree.length, 2);
  assert.equal(result.nextSelectedId, c.id);
});

test("moveNodeRelative nests into lists and rejects nesting into items", () => {
  const target = createNode({ title: "Target", kind: "list" });
  const drag = createNode({ title: "Drag", kind: "item" });
  const item = createNode({ title: "Leaf", kind: "item" });

  const nestedTree = moveNodeRelative([target, drag], drag.id, target.id, "inside");
  const nestedTarget = findNode(nestedTree, target.id);
  assert.equal(nestedTarget.children[0].id, drag.id);

  const rejectedTree = moveNodeRelative([item, drag], drag.id, item.id, "inside");
  assert.equal(rejectedTree.length, 2);
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

