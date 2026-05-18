export const DEFAULT_NODE_WEIGHT = 1;
export const MAX_NODE_WEIGHT = 99;
export const MAX_NODE_URL_LENGTH = 2048;

const VALID_KINDS = new Set(["list", "item"]);

export class TreeValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "TreeValidationError";
  }
}

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

function normalizeWeight(value) {
  if (value === undefined || value === null) {
    return DEFAULT_NODE_WEIGHT;
  }

  if (
    !Number.isSafeInteger(value)
    || value < DEFAULT_NODE_WEIGHT
    || value > MAX_NODE_WEIGHT
  ) {
    throw new TreeValidationError(`Node weight must be an integer from ${DEFAULT_NODE_WEIGHT} to ${MAX_NODE_WEIGHT}.`);
  }

  return value;
}

function normalizeUrl(value) {
  if (value === undefined || value === null) {
    return "";
  }

  if (typeof value !== "string") {
    throw new TreeValidationError("Node URL must be a string.");
  }

  const trimmed = value.trim();
  if (trimmed.length > MAX_NODE_URL_LENGTH) {
    throw new TreeValidationError(`Node URL must be ${MAX_NODE_URL_LENGTH} characters or fewer.`);
  }

  if (/[\0-\x1F\x7F]/.test(trimmed)) {
    throw new TreeValidationError("Node URL cannot contain control characters.");
  }

  return trimmed;
}

function reserveNodeId(rawId, seenIds) {
  if (typeof rawId === "string" && rawId.length > 0 && !seenIds.has(rawId)) {
    seenIds.add(rawId);
    return rawId;
  }

  let generatedId = generateId();
  while (seenIds.has(generatedId)) {
    generatedId = generateId();
  }

  seenIds.add(generatedId);
  return generatedId;
}

function normalizeNode(raw, seenIds = new Set()) {
  if (!isObject(raw)) {
    throw new TreeValidationError("Each node must be an object.");
  }

  const hasExplicitKind = Object.hasOwn(raw, "kind");
  const explicitKind = hasExplicitKind && typeof raw.kind === "string" ? raw.kind : null;
  if (hasExplicitKind && !VALID_KINDS.has(explicitKind)) {
    throw new TreeValidationError("Node kind must be 'list' or 'item'.");
  }

  const hasChildren = Array.isArray(raw.children);
  if (
    Object.hasOwn(raw, "children")
    && raw.children !== null
    && raw.children !== undefined
    && !hasChildren
  ) {
    throw new TreeValidationError("Node children must be an array when present.");
  }

  const kind = explicitKind ?? (hasChildren ? "list" : "item");

  const id = reserveNodeId(raw.id, seenIds);
  const children = kind === "list"
    ? (hasChildren ? raw.children : []).map((child) => normalizeNode(child, seenIds))
    : [];

  if (kind === "item" && hasChildren && raw.children.length > 0) {
    throw new TreeValidationError("Item nodes cannot contain children.");
  }

  return {
    id,
    title: normalizeTitle(raw.title),
    weight: normalizeWeight(raw.weight),
    url: normalizeUrl(raw.url),
    kind,
    isExpanded: kind === "list" ? Boolean(raw.isExpanded) : false,
    children,
  };
}

function normalizeTree(rawTree, expectedMessage) {
  if (!Array.isArray(rawTree)) {
    throw new TreeValidationError(expectedMessage);
  }

  const seenIds = new Set();
  return rawTree.map((node) => normalizeNode(node, seenIds));
}

function collectNodeIds(nodes, ids = new Set()) {
  for (const node of nodes) {
    if (typeof node?.id === "string" && node.id.length > 0) {
      ids.add(node.id);
    }

    if (Array.isArray(node?.children)) {
      collectNodeIds(node.children, ids);
    }
  }

  return ids;
}

function exportNodeToSwift(node) {
  const base = {
    id: node.id,
    isExpanded: Boolean(node.isExpanded),
    title: node.title,
    ...(node.weight !== DEFAULT_NODE_WEIGHT ? { weight: node.weight } : {}),
    ...(node.url ? { url: node.url } : {}),
  };

  if (node.kind === "list" || node.children.length > 0) {
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

function ensureListNode(node) {
  if (node.kind !== "list") {
    node.kind = "list";
    node.isExpanded = true;
    node.children = [];
    return node.children;
  }

  if (!Array.isArray(node.children)) {
    node.children = [];
  }

  return node.children;
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

export function createNode({
  title = "",
  kind = "item",
  weight = DEFAULT_NODE_WEIGHT,
  url = "",
} = {}) {
  return normalizeNode({
    id: generateId(),
    title,
    weight,
    url,
    kind,
    isExpanded: kind === "list",
    children: kind === "list" ? [] : undefined,
  });
}

export function normalizeImportedTree(rawTree) {
  return normalizeTree(rawTree, "Imported data must be an array of nodes.");
}

export function exportToSwiftTree(tree) {
  return validateInternalTree(tree).map(exportNodeToSwift);
}

export function validateInternalTree(tree) {
  return normalizeTree(tree, "Tree must be an array of nodes.");
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
    if (node.isExpanded && node.children.length > 0) {
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

export function updateNodeWeight(tree, nodeId, weight) {
  return updateNode(tree, nodeId, (node) => {
    node.weight = normalizeWeight(weight);
  });
}

export function updateNodeUrl(tree, nodeId, url) {
  return updateNode(tree, nodeId, (node) => {
    node.url = normalizeUrl(url);
  });
}

export function toggleNodeExpanded(tree, nodeId) {
  return updateNode(tree, nodeId, (node) => {
    if (node.kind === "list" || node.children.length > 0) {
      node.isExpanded = !node.isExpanded;
    }
  });
}

export function addRootNode(tree, node) {
  const nextTree = cloneTree(tree);
  nextTree.push(normalizeNode(node, collectNodeIds(nextTree)));
  return validateInternalTree(nextTree);
}

export function addChildNode(tree, parentId, node) {
  const nextTree = cloneTree(tree);
  const parent = findNode(nextTree, parentId);

  if (!parent) {
    return nextTree;
  }

  const normalizedNode = normalizeNode(node, collectNodeIds(nextTree));
  ensureListNode(parent).push(normalizedNode);
  parent.isExpanded = true;
  return validateInternalTree(nextTree);
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
  let targetCollection = null;

  if (parentId === null) {
    targetCollection = nextTree;
  } else {
    const parent = findNode(nextTree, parentId);
    if (parent) {
      targetCollection = ensureListNode(parent);
      parent.isExpanded = true;
    }
  }

  if (!targetCollection) {
    dragLocation.collection.splice(dragLocation.index, 0, dragNode);
    return nextTree;
  }

  const sameCollection = dragLocation.parentId === parentId;
  const adjustedIndex = sameCollection && dragLocation.index < index ? index - 1 : index;
  const safeIndex = Math.max(0, Math.min(adjustedIndex, targetCollection.length));
  targetCollection.splice(safeIndex, 0, dragNode);

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
    return moveNodeToParent(tree, dragId, targetId, targetLocation.node.children.length);
  }

  const insertionIndex = targetLocation.index + (position === "below" ? 1 : 0);
  return moveNodeToParent(tree, dragId, targetLocation.parentId, insertionIndex);
}

export function moveNodeToContainerEnd(tree, dragId, parentId) {
  if (parentId === null) {
    return moveNodeToParent(tree, dragId, null, tree.length);
  }

  const parent = findNode(tree, parentId);
  return moveNodeToParent(tree, dragId, parentId, parent?.children.length ?? 0);
}

export function mergeTrees(existingTree, importedTree) {
  return validateInternalTree([...cloneTree(existingTree), ...cloneTree(importedTree)]);
}
