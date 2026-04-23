const VALID_KINDS = new Set(["list", "item"]);

function generateId() {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }

  return `node-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeTitle(value) {
  if (typeof value !== "string") {
    return "Untitled";
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : "Untitled";
}

function normalizeNode(raw) {
  if (!isObject(raw)) {
    throw new Error("Each node must be an object.");
  }

  const explicitKind = VALID_KINDS.has(raw.kind) ? raw.kind : null;
  const hasChildren = Array.isArray(raw.children);
  const kind = explicitKind ?? (hasChildren ? "list" : "item");

  if (!VALID_KINDS.has(kind)) {
    throw new Error("Node kind must be 'list' or 'item'.");
  }

  const children = kind === "list"
    ? (hasChildren ? raw.children : []).map(normalizeNode)
    : [];

  if (kind === "item" && hasChildren && raw.children.length > 0) {
    throw new Error("Item nodes cannot contain children.");
  }

  return {
    id: typeof raw.id === "string" && raw.id.length > 0 ? raw.id : generateId(),
    title: normalizeTitle(raw.title),
    kind,
    isExpanded: kind === "list" ? Boolean(raw.isExpanded) : false,
    children,
  };
}

function exportNodeToSwift(node) {
  const base = {
    id: node.id,
    isExpanded: Boolean(node.isExpanded),
    title: node.title,
  };

  if (node.kind === "list") {
    return {
      ...base,
      children: node.children.map(exportNodeToSwift),
    };
  }

  return base;
}

function visit(nodes, matcher, parentId = null) {
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index];
    const found = matcher(node, { parentId, index, collection: nodes });
    if (found) {
      return found;
    }

    if (node.children.length > 0) {
      const nested = visit(node.children, matcher, node.id);
      if (nested) {
        return nested;
      }
    }
  }

  return null;
}

function getChildrenCollection(tree, parentId) {
  if (parentId === null) {
    return tree;
  }

  const parent = findNode(tree, parentId);
  if (!parent || parent.kind !== "list") {
    return null;
  }

  return parent.children;
}

function computeDeleteFallback(tree, parentId, index) {
  const siblings = getChildrenCollection(tree, parentId) ?? [];

  if (siblings[index]) {
    return siblings[index].id;
  }

  if (siblings[index - 1]) {
    return siblings[index - 1].id;
  }

  if (parentId !== null) {
    return parentId;
  }

  return tree[0]?.id ?? null;
}

export function cloneTree(tree) {
  return structuredClone(tree);
}

export function createNode({ title = "", kind = "item" } = {}) {
  return normalizeNode({
    id: generateId(),
    title,
    kind,
    isExpanded: kind === "list",
    children: kind === "list" ? [] : undefined,
  });
}

export function normalizeImportedTree(rawTree) {
  if (!Array.isArray(rawTree)) {
    throw new Error("Imported data must be an array of nodes.");
  }

  return rawTree.map(normalizeNode);
}

export function exportToSwiftTree(tree) {
  return validateInternalTree(tree).map(exportNodeToSwift);
}

export function validateInternalTree(tree) {
  if (!Array.isArray(tree)) {
    throw new Error("Tree must be an array of nodes.");
  }

  return tree.map(normalizeNode);
}

export function findNode(tree, nodeId) {
  return visit(tree, (node) => (node.id === nodeId ? node : null));
}

export function findNodeLocation(tree, nodeId) {
  return visit(tree, (node, context) => (node.id === nodeId ? { ...context, node } : null));
}

export function isDescendant(tree, nodeId, ancestorId) {
  const ancestor = findNode(tree, ancestorId);
  if (!ancestor || ancestor.children.length === 0) {
    return false;
  }

  return Boolean(findNode(ancestor.children, nodeId));
}

export function getFirstRootId(tree) {
  return tree[0]?.id ?? null;
}

export function deriveSelection(tree, selectedId) {
  if (selectedId && findNode(tree, selectedId)) {
    return selectedId;
  }

  return getFirstRootId(tree);
}

export function findParentId(tree, nodeId) {
  return findNodeLocation(tree, nodeId)?.parentId ?? null;
}

export function findPath(tree, nodeId) {
  const path = [];

  function walk(nodes) {
    for (const node of nodes) {
      path.push(node);
      if (node.id === nodeId) {
        return true;
      }

      if (walk(node.children)) {
        return true;
      }

      path.pop();
    }

    return false;
  }

  if (!walk(tree)) {
    return [];
  }

  return [...path];
}

export function flattenVisibleTree(tree, depth = 0, parentId = null) {
  const rows = [];

  for (const node of tree) {
    rows.push({ node, depth, parentId });
    if (node.kind === "list" && node.isExpanded && node.children.length > 0) {
      rows.push(...flattenVisibleTree(node.children, depth + 1, node.id));
    }
  }

  return rows;
}

export function updateNode(tree, nodeId, updater) {
  const nextTree = cloneTree(tree);
  const location = findNodeLocation(nextTree, nodeId);

  if (!location) {
    return nextTree;
  }

  updater(location.node);
  return nextTree;
}

export function updateNodeTitle(tree, nodeId, title) {
  return updateNode(tree, nodeId, (node) => {
    node.title = normalizeTitle(title);
  });
}

export function toggleNodeExpanded(tree, nodeId) {
  return updateNode(tree, nodeId, (node) => {
    if (node.kind === "list") {
      node.isExpanded = !node.isExpanded;
    }
  });
}

export function addRootNode(tree, node) {
  return [...cloneTree(tree), normalizeNode(node)];
}

export function addChildNode(tree, parentId, node) {
  const nextTree = cloneTree(tree);
  const parent = findNode(nextTree, parentId);

  if (!parent) {
    return nextTree;
  }

  if (parent.kind !== "list") {
    parent.kind = "list";
    parent.isExpanded = true;
    parent.children = [];
  }

  parent.children.push(normalizeNode(node));
  parent.isExpanded = true;
  return nextTree;
}

export function deleteNode(tree, nodeId, selectedId) {
  const nextTree = cloneTree(tree);
  const location = findNodeLocation(nextTree, nodeId);

  if (!location) {
    return {
      tree: nextTree,
      nextSelectedId: deriveSelection(nextTree, selectedId),
    };
  }

  location.collection.splice(location.index, 1);

  return {
    tree: nextTree,
    nextSelectedId:
      selectedId === nodeId || !findNode(nextTree, selectedId)
        ? computeDeleteFallback(nextTree, location.parentId, location.index)
        : selectedId,
  };
}

export function moveNodeToParent(tree, dragId, parentId, index) {
  if (parentId === dragId) {
    return cloneTree(tree);
  }

  if (parentId !== null && isDescendant(tree, parentId, dragId)) {
    return cloneTree(tree);
  }

  const nextTree = cloneTree(tree);
  const dragLocation = findNodeLocation(nextTree, dragId);

  if (!dragLocation) {
    return nextTree;
  }

  const [dragNode] = dragLocation.collection.splice(dragLocation.index, 1);
  const targetCollection = getChildrenCollection(nextTree, parentId);

  if (!targetCollection) {
    dragLocation.collection.splice(dragLocation.index, 0, dragNode);
    return nextTree;
  }

  const sameCollection = dragLocation.parentId === parentId;
  const adjustedIndex = sameCollection && dragLocation.index < index ? index - 1 : index;
  const safeIndex = Math.max(0, Math.min(adjustedIndex, targetCollection.length));
  targetCollection.splice(safeIndex, 0, dragNode);

  const parent = parentId ? findNode(nextTree, parentId) : null;
  if (parent?.kind === "list") {
    parent.isExpanded = true;
  }

  return nextTree;
}

export function moveNodeRelative(tree, dragId, targetId, position) {
  if (!["above", "below", "inside"].includes(position)) {
    return cloneTree(tree);
  }

  if (dragId === targetId) {
    return cloneTree(tree);
  }

  const targetLocation = findNodeLocation(tree, targetId);
  if (!targetLocation) {
    return cloneTree(tree);
  }

  if (position === "inside") {
    if (targetLocation.node.kind !== "list") {
      return cloneTree(tree);
    }

    return moveNodeToParent(tree, dragId, targetId, targetLocation.node.children.length);
  }

  const insertionIndex = targetLocation.index + (position === "below" ? 1 : 0);
  return moveNodeToParent(tree, dragId, targetLocation.parentId, insertionIndex);
}

export function moveNodeToContainerEnd(tree, dragId, parentId) {
  const targetCollection = getChildrenCollection(tree, parentId);
  if (!targetCollection) {
    return cloneTree(tree);
  }

  return moveNodeToParent(tree, dragId, parentId, targetCollection.length);
}

export function mergeTrees(existingTree, importedTree) {
  return [...cloneTree(existingTree), ...cloneTree(importedTree)];
}

