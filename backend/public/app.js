import Sortable from "/vendor/sortablejs.js";
import {
  addChildNode,
  addRootNode,
  cloneTree,
  createNode,
  deleteNode,
  deriveSelection,
  exportToSwiftTree,
  findNode,
  findParentId,
  findPath,
  flattenVisibleTree,
  MAX_NODE_URL_LENGTH,
  MAX_NODE_WEIGHT,
  getFirstRootId,
  moveNodeRelative,
  moveNodeToContainerEnd,
  moveNodeToParent,
  toggleNodeExpanded,
  updateNodeTitle,
  updateNodeUrl,
  updateNodeWeight,
} from "/shared/tree.js";

const app = document.querySelector("#app");
const RANDOM_ROW_STEP_MS = 90;
const RANDOM_ROW_FLASH_MS = 900;
const SAVE_STATUS_LABELS = {
  loading: "Loading",
  dirty: "Unsaved",
  saving: "Saving",
  saved: "Saved",
  error: "Save error",
  conflict: "Conflict",
};

function createEmptyDragState() {
  return {
    nodeId: null,
    scope: null,
    targetId: null,
    position: null,
    targetIndex: null,
  };
}

function createEmptyRandomPickState() {
  return {
    highlightId: null,
    pickedId: null,
  };
}

function createDeleteUndoSnapshot(title) {
  return {
    title,
    tree: cloneTree(state.tree),
    selectedId: state.selectedId,
  };
}

const state = {
  tree: [],
  version: 0,
  selectedId: null,
  saveStatus: "loading",
  errorMessage: "",
  composerTitle: "",
  composerUrl: "",
  outlineFilter: "",
  importDialog: null,
  shortcutsDialog: false,
  randomPick: createEmptyRandomPickState(),
  outlineOpen: false,
  drag: createEmptyDragState(),
  conflictState: null,
  deleteUndo: null,
};

let saveTimer = null;
let saveInFlight = false;
let pendingSave = false;
let pendingSaveShouldRender = false;
let saveGeneration = 0;
let sidebarSortable = null;
let detailSortable = null;
let randomPickTimers = [];
let randomPickGeneration = 0;
const dragDecorationClasses = [
  "is-dragging",
  "is-drop-above",
  "is-drop-inside",
  "is-drop-below",
  "is-drop-before",
  "is-drop-invalid",
];
const randomPickDecorationClasses = [
  "is-random-highlighted",
  "is-random-picked",
];

function dragStateEquals(nextDrag) {
  return state.drag.nodeId === nextDrag.nodeId
    && state.drag.scope === nextDrag.scope
    && state.drag.targetId === nextDrag.targetId
    && state.drag.position === nextDrag.position
    && state.drag.targetIndex === nextDrag.targetIndex;
}

function setDragState(nextDrag) {
  if (dragStateEquals(nextDrag)) {
    return;
  }

  state.drag = nextDrag;
  syncDragDecorations();
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function escapeAttribute(value) {
  return escapeHtml(value);
}

function applyAppearance() {
  document.documentElement.dataset.theme = "dark";
}

function getSaveStatusLabel(status = state.saveStatus) {
  return SAVE_STATUS_LABELS[status] || "Unknown";
}

function syncSaveStatus() {
  const element = app.querySelector('[data-role="save-status"]');
  if (!element) {
    return;
  }

  element.textContent = getSaveStatusLabel();
  element.className = `save-status save-status-${state.saveStatus}`;
}

function setSaveStatus(status) {
  state.saveStatus = status;
  syncSaveStatus();
}

function getOutlineFilter() {
  return state.outlineFilter.trim().toLowerCase();
}

function nodeMatchesOutlineFilter(node, filter) {
  return node.title.toLowerCase().includes(filter)
    || node.url.toLowerCase().includes(filter);
}

function flattenFilteredTree(nodes, filter, depth = 0) {
  const rows = [];

  for (const node of nodes) {
    const childRows = flattenFilteredTree(node.children, filter, depth + 1);
    const isFilterMatch = nodeMatchesOutlineFilter(node, filter);

    if (isFilterMatch || childRows.length > 0) {
      rows.push({
        node,
        depth,
        isFilterMatch,
      });
      rows.push(...childRows);
    }
  }

  return rows;
}

function getVisibleRows() {
  const filter = getOutlineFilter();
  return filter ? flattenFilteredTree(state.tree, filter) : flattenVisibleTree(state.tree);
}

function getSelectedNode() {
  return state.selectedId ? findNode(state.tree, state.selectedId) : null;
}

function isSelected(nodeId) {
  return state.selectedId === nodeId;
}

function nodeHasChildren(node) {
  return Array.isArray(node?.children) && node.children.length > 0;
}

function getWebsiteHref(rawUrl) {
  const trimmed = typeof rawUrl === "string" ? rawUrl.trim() : "";
  if (!trimmed) {
    return null;
  }

  const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(candidate);
    if (!["http:", "https:"].includes(url.protocol) || !url.hostname) {
      return null;
    }

    return url.href;
  } catch {
    return null;
  }
}

function nodeHasWebsite(node) {
  return Boolean(getWebsiteHref(node?.url));
}

function formatWeightChance(weight, totalWeight) {
  if (!Number.isFinite(totalWeight) || totalWeight <= 0) {
    return "0%";
  }

  const chance = (weight / totalWeight) * 100;
  if (chance > 0 && chance < 1) {
    return "<1%";
  }

  if (chance > 99 && chance < 100) {
    return ">99%";
  }

  return `${Math.round(chance)}%`;
}

function normalizeComposerLine(line) {
  return line
    .trim()
    .replace(/^[-*]\s+/, "")
    .replace(/^\d+[.)]\s+/, "")
    .trim();
}

function getComposerTitles() {
  return state.composerTitle
    .split(/\r?\n/)
    .map(normalizeComposerLine)
    .filter(Boolean);
}

function isDropInvalid(nodeId, dragId = state.drag.nodeId) {
  if (!dragId) {
    return false;
  }

  if (dragId === nodeId) {
    return true;
  }

  const dragged = findNode(state.tree, dragId);
  const target = findNode(state.tree, nodeId);

  if (!dragged || !target) {
    return false;
  }

  return dragged.id === target.id || findPath([dragged], nodeId).length > 0;
}

function clearDragDecorations() {
  for (const className of dragDecorationClasses) {
    app.querySelectorAll(`.${className}`).forEach((element) => {
      element.classList.remove(className);
    });
  }
}

function clearRandomPickDecorations() {
  for (const className of randomPickDecorationClasses) {
    app.querySelectorAll(`.${className}`).forEach((element) => {
      element.classList.remove(className);
    });
  }
}

function getDataSelector(value) {
  if (globalThis.CSS?.escape) {
    return CSS.escape(value);
  }

  return String(value).replace(/[\0-\x1F\x7F"\\]/g, (character) => {
    const codePoint = character.charCodeAt(0).toString(16);
    return `\\${codePoint} `;
  });
}

function syncWebsiteButtons(nodeId) {
  if (!nodeId) {
    return;
  }

  const hasWebsite = nodeHasWebsite(findNode(state.tree, nodeId));
  app.querySelectorAll(
    `[data-action="open-url"][data-node-id="${getDataSelector(nodeId)}"]`,
  ).forEach((element) => {
    if (element instanceof HTMLButtonElement) {
      element.disabled = !hasWebsite;
    }
  });
}

function syncDragDecorations() {
  clearDragDecorations();

  if (!state.drag.nodeId) {
    return;
  }

  if (state.drag.scope === "sidebar") {
    const draggedRow = app.querySelector(
      `[data-role="sidebar-row"][data-node-id="${getDataSelector(state.drag.nodeId)}"]`,
    );
    draggedRow?.classList.add("is-dragging");

    if (state.drag.targetId === "__root-end__") {
      app.querySelector('[data-role="sidebar-end-drop"]')?.classList.add("is-drop-before");
      return;
    }

    if (!state.drag.targetId) {
      return;
    }

    const targetRow = app.querySelector(
      `[data-role="sidebar-row"][data-node-id="${getDataSelector(state.drag.targetId)}"]`,
    );
    if (!targetRow) {
      return;
    }

    if (isDropInvalid(state.drag.targetId)) {
      targetRow.classList.add("is-drop-invalid");
      return;
    }

    if (state.drag.position) {
      targetRow.classList.add(`is-drop-${state.drag.position}`);
    }

    return;
  }

  if (state.drag.scope !== "detail") {
    return;
  }

  const draggedRow = app.querySelector(
    `[data-role="detail-row"][data-node-id="${getDataSelector(state.drag.nodeId)}"]`,
  );
  draggedRow?.classList.add("is-dragging");

  if (state.drag.targetIndex === null) {
    return;
  }

  const rowTarget = app.querySelector(
    `[data-role="detail-row"][data-index="${state.drag.targetIndex}"]`,
  );
  if (rowTarget) {
    rowTarget.classList.add("is-drop-before");
  }
}

function resetDragState() {
  state.drag = createEmptyDragState();
  clearDragDecorations();
}

function syncSortables() {
  syncSidebarSortable();
  syncDetailSortable();
}

function syncSidebarSortable() {
  sidebarSortable?.destroy();
  sidebarSortable = null;

  if (getOutlineFilter()) {
    return;
  }

  const treeList = document.querySelector(".tree-list");
  const sidebarRows = treeList?.querySelectorAll('[data-role="sidebar-row"]') || [];
  if (!treeList || sidebarRows.length === 0) {
    return;
  }

  sidebarSortable = Sortable.create(treeList, {
    animation: 140,
    draggable: '[data-role="sidebar-row"]',
    dragClass: "sortable-drag",
    fallbackOnBody: true,
    fallbackTolerance: 3,
    forceFallback: true,
    ghostClass: "sortable-ghost",
    handle: '[data-role="sidebar-handle"]',
    invertSwap: true,
    swapThreshold: 0.65,
    chosenClass: "sortable-chosen",
    onStart(event) {
      clearRandomPickAnimation();
      setDragState({
        ...createEmptyDragState(),
        nodeId: event.item.dataset.nodeId,
        scope: "sidebar",
      });
    },
    onMove(event, originalEvent) {
      if (!state.drag.nodeId || !originalEvent) {
        return true;
      }

      const endDrop = originalEvent.target?.closest?.('[data-role="sidebar-end-drop"]');
      if (endDrop) {
        setDragState({
          ...state.drag,
          targetId: "__root-end__",
          position: "end",
        });
        return true;
      }

      const relatedRow = event.related?.closest?.('[data-role="sidebar-row"]');
      if (!relatedRow) {
        return true;
      }

      setDragState({
        ...state.drag,
        targetId: relatedRow.dataset.nodeId,
        position: computeSidebarDropPosition(relatedRow, originalEvent.clientY),
      });
      return true;
    },
    onEnd() {
      const drag = { ...state.drag };

      if (!drag.nodeId) {
        resetDragState();
        render();
        return;
      }

      if (drag.targetId === "__root-end__") {
        resetDragState();
        commitTree(moveNodeToContainerEnd(state.tree, drag.nodeId, null), state.selectedId, 0);
        return;
      }

      if (drag.targetId && drag.position && !isDropInvalid(drag.targetId, drag.nodeId)) {
        resetDragState();
        const nextTree = moveNodeRelative(
          state.tree,
          drag.nodeId,
          drag.targetId,
          drag.position,
        );
        commitTree(nextTree, state.selectedId, 0);
        return;
      }

      resetDragState();
      render();
    },
  });
}

function syncDetailSortable() {
  detailSortable?.destroy();
  detailSortable = null;

  const detailList = document.querySelector(".detail-list");
  const selectedNode = getSelectedNode();
  if (!detailList || !selectedNode || selectedNode.children.length < 2) {
    return;
  }

  detailSortable = Sortable.create(detailList, {
    animation: 140,
    draggable: '[data-role="detail-row"]',
    dragClass: "sortable-drag",
    fallbackOnBody: true,
    fallbackTolerance: 3,
    forceFallback: true,
    ghostClass: "sortable-ghost",
    handle: '[data-role="detail-handle"]',
    chosenClass: "sortable-chosen",
    onStart(event) {
      clearRandomPickAnimation();
      setDragState({
        ...createEmptyDragState(),
        nodeId: event.item.dataset.nodeId,
        scope: "detail",
        targetIndex: Number(event.item.dataset.index),
      });
    },
    onMove(event) {
      const relatedIndex = event.related?.dataset.index;
      const targetIndex =
        relatedIndex === undefined
          ? selectedNode.children.length
          : Number(relatedIndex) + (event.willInsertAfter ? 1 : 0);

      setDragState({
        ...state.drag,
        targetIndex,
      });
      return true;
    },
    onEnd(event) {
      const drag = { ...state.drag };

      if (!selectedNode || !drag.nodeId) {
        resetDragState();
        render();
        return;
      }

      const nextIndex =
        typeof event.newDraggableIndex === "number" ? event.newDraggableIndex : event.newIndex;
      if (typeof nextIndex !== "number") {
        resetDragState();
        render();
        return;
      }

      resetDragState();
      commitTree(
        moveNodeToParent(state.tree, drag.nodeId, selectedNode.id, nextIndex),
        selectedNode.id,
        0,
      );
    },
  });
}

function focusModalAction() {
  if (!state.importDialog && !state.shortcutsDialog) {
    return;
  }

  document.querySelector(".modal-card [data-autofocus]")?.focus();
}

function focusTreeSelection() {
  document.querySelector('[data-action="select-node"][aria-current="true"]')?.focus();
}

function focusSelectedTitle() {
  if (!state.selectedId) {
    return;
  }

  const input = document.querySelector(
    `.detail-title-input[data-node-id="${getDataSelector(state.selectedId)}"]`,
  );

  if (!(input instanceof HTMLInputElement)) {
    return;
  }

  input.focus();
  input.select();
}

function focusComposerInput() {
  document.querySelector('[name="composerTitle"]')?.focus();
}

function focusOutlineFilter() {
  state.outlineOpen = true;
  render();
  document.querySelector(".outline-search-input")?.focus();
}

function setSelectionAndFocus(nodeId) {
  clearRandomPickAnimation();
  state.selectedId = deriveSelection(state.tree, nodeId);
  render();
  focusTreeSelection();
}

function selectVisibleRow(offset) {
  const rows = getVisibleRows();
  const currentIndex = rows.findIndex(({ node }) => node.id === state.selectedId);
  if (currentIndex === -1) {
    if (rows[0]) {
      setSelectionAndFocus(rows[0].node.id);
    }
    return;
  }

  const nextRow = rows[currentIndex + offset];
  if (!nextRow) {
    return;
  }

  setSelectionAndFocus(nextRow.node.id);
}

function moveSelectionHome() {
  const firstVisible = getVisibleRows()[0];
  if (!firstVisible) {
    return;
  }

  setSelectionAndFocus(firstVisible.node.id);
}

function moveSelectionToCurrentRoot() {
  const [rootNode] = findPath(state.tree, state.selectedId);
  if (!rootNode) {
    return;
  }

  state.outlineOpen = false;
  setSelectionAndFocus(rootNode.id);
}

function moveSelectionEnd() {
  const rows = getVisibleRows();
  const lastVisible = rows[rows.length - 1];
  if (!lastVisible) {
    return;
  }

  setSelectionAndFocus(lastVisible.node.id);
}

function navigateLeft() {
  const selectedNode = getSelectedNode();
  if (!selectedNode) {
    return;
  }

  if (getOutlineFilter()) {
    const parentId = findParentId(state.tree, selectedNode.id);
    if (parentId) {
      setSelectionAndFocus(parentId);
    }
    return;
  }

  if (nodeHasChildren(selectedNode) && selectedNode.isExpanded) {
    clearRandomPickAnimation();
    state.tree = toggleNodeExpanded(state.tree, selectedNode.id);
    render();
    queueSave(0, false);
    focusTreeSelection();
    return;
  }

  const parentId = findParentId(state.tree, selectedNode.id);
  if (!parentId) {
    return;
  }

  setSelectionAndFocus(parentId);
}

function navigateRight() {
  const selectedNode = getSelectedNode();
  if (!selectedNode || !nodeHasChildren(selectedNode)) {
    return;
  }

  if (getOutlineFilter()) {
    const rows = getVisibleRows();
    const currentIndex = rows.findIndex(({ node }) => node.id === selectedNode.id);
    const nextRow = rows[currentIndex + 1];
    const currentDepth = rows[currentIndex]?.depth;
    if (nextRow && currentDepth !== undefined && nextRow.depth > currentDepth) {
      setSelectionAndFocus(nextRow.node.id);
    }
    return;
  }

  if (!selectedNode.isExpanded) {
    clearRandomPickAnimation();
    state.tree = toggleNodeExpanded(state.tree, selectedNode.id);
    render();
    queueSave(0, false);
    focusTreeSelection();
    return;
  }

  const firstChildId = selectedNode.children[0]?.id;
  if (!firstChildId) {
    return;
  }

  setSelectionAndFocus(firstChildId);
}

function renderSidebarRows(rows, { isFiltered = false } = {}) {
  if (rows.length === 0) {
    if (isFiltered) {
      return `
        <div class="sidebar-empty">
          <p>No matches.</p>
          <p>Try another search.</p>
        </div>
      `;
    }

    return `
      <div class="sidebar-empty">
        <p>No nodes yet.</p>
        <p>Create a root or import JSON.</p>
      </div>
    `;
  }

  return rows
    .map(({ node, depth, isFilterMatch = false }) => {
      const nodeId = escapeAttribute(node.id);
      const classes = [
        "tree-row",
        isSelected(node.id) ? "is-selected" : "",
        isFiltered ? "is-filtered" : "",
        isFiltered && isFilterMatch ? "is-filter-match" : "",
        isFiltered && !isFilterMatch ? "is-filter-context" : "",
      ]
        .filter(Boolean)
        .join(" ");
      const canExpand = nodeHasChildren(node);
      const canToggle = canExpand && !isFiltered;
      const expandedAttribute = canToggle
        ? `aria-expanded="${node.isExpanded ? "true" : "false"}"`
        : "";

      return `
        <div
          class="${classes}"
          data-role="sidebar-row"
          data-node-id="${nodeId}"
          role="treeitem"
          aria-level="${depth + 1}"
          aria-selected="${isSelected(node.id) ? "true" : "false"}"
          ${expandedAttribute}
          style="--depth:${depth};"
        >
          <button
            class="tree-grip"
            data-role="sidebar-handle"
            data-node-id="${nodeId}"
            aria-label="Drag to move ${escapeHtml(node.title)}"
            ${isFiltered ? "disabled" : ""}
            type="button"
          >⋮⋮</button>
          <button
            class="tree-toggle"
            data-action="toggle-expand"
            data-node-id="${nodeId}"
            ${canToggle ? "" : "disabled"}
            aria-label="${canToggle && node.isExpanded ? "Collapse" : "Expand"}"
            aria-hidden="${canToggle ? "false" : "true"}"
            type="button"
          >
            ${canToggle ? (node.isExpanded ? "▾" : "▸") : ""}
          </button>
          <button
            class="tree-main"
            data-action="select-node"
            data-node-id="${nodeId}"
            aria-current="${isSelected(node.id) ? "true" : "false"}"
            aria-label="Select ${escapeHtml(node.title)}"
            type="button"
          >
            <span class="tree-title">${escapeHtml(node.title)}</span>
          </button>
          <div class="tree-actions">
            <button class="icon-button" data-action="add-child-node" data-node-id="${nodeId}" aria-label="Add child node inside ${escapeHtml(node.title)}" type="button">+</button>
            <button class="icon-button" data-action="delete-node" data-node-id="${nodeId}" aria-label="Delete ${escapeHtml(node.title)}" type="button">×</button>
          </div>
        </div>
      `;
    })
    .join("");
}

function renderDetailContent(selectedNode) {
  if (!selectedNode) {
    return `
      <section class="detail-card empty-state">
        <h2>No selection</h2>
        <p>Select a node from the outline.</p>
      </section>
    `;
  }

  const path = findPath(state.tree, selectedNode.id)
    .map((node) => escapeHtml(node.title))
    .join(" / ");

  const children = selectedNode.children;
  const selectedNodeId = escapeAttribute(selectedNode.id);
  const parentId = findParentId(state.tree, selectedNode.id);
  const selectedHasWebsite = nodeHasWebsite(selectedNode);
  const totalWeight = children.reduce((total, child) => total + getNodeWeight(child), 0);
  const rows = children.length
    ? children
        .map((child, index) => {
          const childId = escapeAttribute(child.id);
          const childWeight = getNodeWeight(child);
          const childChance = formatWeightChance(childWeight, totalWeight);
          const childChanceText = escapeHtml(childChance);
          const childHasWebsite = nodeHasWebsite(child);
          const rowClasses = [
            "detail-row",
            state.randomPick.highlightId === child.id ? "is-random-highlighted" : "",
            state.randomPick.pickedId === child.id ? "is-random-picked" : "",
          ]
            .filter(Boolean)
            .join(" ");

          return `
            <div
              class="${rowClasses}"
              data-role="detail-row"
              data-node-id="${childId}"
              data-index="${index}"
              role="listitem"
            >
              <button
                class="drag-handle"
                data-role="detail-handle"
                data-node-id="${childId}"
                data-index="${index}"
                aria-label="Drag to reorder ${escapeHtml(child.title)}"
                type="button"
              >⋮⋮</button>
              <input
                class="detail-input"
                data-action="edit-title"
                data-node-id="${childId}"
                aria-label="Child node title"
                value="${escapeHtml(child.title)}"
              />
              <input
                class="detail-url-input"
                data-action="edit-url"
                data-node-id="${childId}"
                aria-label="Website link for ${escapeHtml(child.title)}"
                placeholder="Link"
                maxlength="${MAX_NODE_URL_LENGTH}"
                value="${escapeHtml(child.url)}"
              />
              <div class="weight-control" role="group" aria-label="Weight for ${escapeHtml(child.title)}">
                <button
                  class="icon-button weight-button"
                  data-action="change-weight"
                  data-node-id="${childId}"
                  data-delta="-1"
                  ${childWeight <= 1 ? "disabled" : ""}
                  aria-label="Decrease weight for ${escapeHtml(child.title)}"
                  type="button"
                >-</button>
                <span class="weight-value" aria-label="Weight ${childWeight}">${childWeight}</span>
                <span class="weight-chance" aria-label="Random chance ${escapeAttribute(childChance)}">${childChanceText}</span>
                <button
                  class="icon-button weight-button"
                  data-action="change-weight"
                  data-node-id="${childId}"
                  data-delta="1"
                  ${childWeight >= MAX_NODE_WEIGHT ? "disabled" : ""}
                  aria-label="Increase weight for ${escapeHtml(child.title)}"
                  type="button"
                >+</button>
              </div>
              <button class="button button-ghost" data-action="open-url" data-node-id="${childId}" ${childHasWebsite ? "" : "disabled"} aria-label="Open link for ${escapeHtml(child.title)}" type="button">Open link</button>
              <button class="button button-ghost" data-action="open-node" data-node-id="${childId}" aria-label="Open ${escapeHtml(child.title)}" type="button">Open</button>
              <button class="button button-ghost" data-action="delete-node" data-node-id="${childId}" aria-label="Delete ${escapeHtml(child.title)}" type="button">Delete</button>
            </div>
          `;
        })
        .join("")
    : `
        <div class="empty-list">
          <p>No child nodes yet.</p>
          <p>Add one below or drop a node here.</p>
        </div>
      `;

  return `
    <section class="detail-card">
      <div class="detail-header">
        <div>
          <p class="detail-path">${path}</p>
          <div class="detail-title-row">
            <input
              class="detail-title-input"
              data-action="edit-title"
              data-node-id="${selectedNodeId}"
              aria-label="Selected node title"
              value="${escapeHtml(selectedNode.title)}"
            />
          </div>
          <div class="detail-link-row">
            <input
              class="detail-url-input detail-link-input"
              data-action="edit-url"
              data-node-id="${selectedNodeId}"
              aria-label="Selected node website link"
              placeholder="Link"
              maxlength="${MAX_NODE_URL_LENGTH}"
              value="${escapeHtml(selectedNode.url)}"
            />
            <button
              class="button button-ghost"
              data-action="open-url"
              data-node-id="${selectedNodeId}"
              ${selectedHasWebsite ? "" : "disabled"}
              type="button"
            >Open link</button>
          </div>
          <p class="detail-meta">
            ${children.length} child ${children.length === 1 ? "node" : "nodes"}
            ${children.length > 0 ? ` / total weight ${totalWeight}` : ""}
          </p>
        </div>
        <div class="detail-header-actions">
          ${
            parentId
              ? `<button class="button button-ghost" data-action="select-node" data-node-id="${escapeAttribute(parentId)}" type="button">Back to parent</button>`
              : ""
          }
          <button class="button button-primary" data-action="pick-random" data-node-id="${selectedNodeId}" ${children.length === 0 ? "disabled" : ""} type="button">Pick random</button>
        </div>
      </div>

      <div class="detail-list" role="list" aria-label="Child nodes">
        ${rows}
      </div>

      <form class="composer" data-action="submit-composer">
        <textarea
          class="composer-input composer-title-input"
          name="composerTitle"
          aria-label="New child node title"
          placeholder="Add nodes"
          rows="2"
        >${escapeHtml(state.composerTitle)}</textarea>
        <input
          class="composer-input composer-url-input"
          name="composerUrl"
          aria-label="New child website link"
          placeholder="Link (optional)"
          maxlength="${MAX_NODE_URL_LENGTH}"
          value="${escapeHtml(state.composerUrl)}"
        />
        <button class="button button-primary" type="submit">Add</button>
      </form>
    </section>
  `;
}

function renderImportDialog() {
  if (!state.importDialog) {
    return "";
  }

  return `
    <div class="modal-backdrop" data-action="close-import-dialog">
      <div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="import-title">
        <h2 id="import-title">Import ${escapeHtml(state.importDialog.fileName)}</h2>
        <p>The file is loaded. Replace this list file or add the imported roots to it.</p>
        <div class="modal-actions">
          <button class="button button-primary" data-action="confirm-import" data-mode="replace" data-autofocus type="button">Replace current data</button>
          <button class="button button-ghost" data-action="confirm-import" data-mode="merge" type="button">Merge imported roots</button>
          <button class="button button-ghost" data-action="close-import-dialog" type="button">Cancel</button>
        </div>
      </div>
    </div>
  `;
}

function renderShortcutKeys(keys) {
  return `
    <span class="shortcut-keys">
      ${keys.map((key) => `<kbd>${escapeHtml(key)}</kbd>`).join("<span>+</span>")}
    </span>
  `;
}

function renderShortcutRow(keys, label) {
  return `
    <div class="shortcut-row">
      <dt>${renderShortcutKeys(keys)}</dt>
      <dd>${escapeHtml(label)}</dd>
    </div>
  `;
}

function renderShortcutsDialog() {
  if (!state.shortcutsDialog) {
    return "";
  }

  const modifier = /Mac|iPhone|iPad|iPod/.test(navigator.platform) ? "Cmd" : "Ctrl";

  return `
    <div class="modal-backdrop" data-action="close-shortcuts-dialog">
      <div class="modal-card modal-card-wide" role="dialog" aria-modal="true" aria-labelledby="shortcuts-title">
        <div class="modal-heading">
          <h2 id="shortcuts-title">Keyboard shortcuts</h2>
          <button class="button button-ghost" data-action="close-shortcuts-dialog" data-autofocus type="button">Close</button>
        </div>
        <div class="shortcut-sections">
          <section class="shortcut-section">
            <h3>Navigate</h3>
            <dl class="shortcut-list">
              ${renderShortcutRow(["Up", "Down"], "Move selection")}
              ${renderShortcutRow(["Left"], "Collapse or move to parent")}
              ${renderShortcutRow(["Shift", "Left"], "Move to current root")}
              ${renderShortcutRow(["E"], "Move to current root")}
              ${renderShortcutRow(["Right"], "Expand or move to first child")}
              ${renderShortcutRow(["Home"], "Move to first visible node")}
              ${renderShortcutRow(["End"], "Move to last visible node")}
              ${renderShortcutRow(["F"], "Search outline")}
              ${renderShortcutRow([modifier, "1"], "Move to first root")}
            </dl>
          </section>
          <section class="shortcut-section">
            <h3>Edit</h3>
            <dl class="shortcut-list">
              ${renderShortcutRow(["N"], "Add child to selection")}
              ${renderShortcutRow(["Shift", "N"], "Add root node")}
              ${renderShortcutRow(["/"], "Focus add-child field")}
              ${renderShortcutRow(["Delete"], "Delete selected node")}
              ${renderShortcutRow([modifier, "Z"], "Undo deleted node")}
              ${renderShortcutRow([modifier, "S"], "Save now")}
            </dl>
          </section>
          <section class="shortcut-section">
            <h3>Tools</h3>
            <dl class="shortcut-list">
              ${renderShortcutRow(["R"], "Pick random child")}
              ${renderShortcutRow([modifier, "R"], "Pick random child")}
              ${renderShortcutRow([modifier, "O"], "Import JSON")}
              ${renderShortcutRow([modifier, "E"], "Export JSON")}
              ${renderShortcutRow(["?"], "Show shortcuts")}
              ${renderShortcutRow(["Esc"], "Close dialog")}
            </dl>
          </section>
        </div>
      </div>
    </div>
  `;
}

function renderConflictBanner() {
  if (state.saveStatus !== "conflict" || !state.conflictState) {
    return "";
  }

  return `
    <div class="banner banner-warning" role="alert">
      <p>Your local copy differs from a newer server version.</p>
      <div class="banner-actions">
        <button class="button button-primary" data-action="reload-server-state" type="button">Reload server copy</button>
        <button class="button button-ghost" data-action="overwrite-server-state" type="button">Overwrite with local copy</button>
      </div>
    </div>
  `;
}

function renderDeleteUndoBanner() {
  if (!state.deleteUndo || state.saveStatus === "conflict") {
    return "";
  }

  return `
    <div class="banner banner-info" role="status">
      <p>Deleted ${escapeHtml(state.deleteUndo.title)}.</p>
      <div class="banner-actions">
        <button class="button button-primary" data-action="undo-delete" type="button">Undo</button>
        <button class="button button-ghost" data-action="dismiss-delete-undo" type="button">Dismiss</button>
      </div>
    </div>
  `;
}

function render() {
  applyAppearance();
  const outlineFilter = getOutlineFilter();
  const isFiltered = Boolean(outlineFilter);
  const sidebarRows = getVisibleRows();
  const outlineMatchCount = isFiltered
    ? sidebarRows.filter((row) => row.isFilterMatch).length
    : 0;
  const selectedNode = getSelectedNode();

  app.innerHTML = `
    <div class="shell">
      <header class="topbar">
        <div class="brand-block">
          <h1>RandomPick</h1>
        </div>
        <span
          class="save-status save-status-${state.saveStatus}"
          data-role="save-status"
          role="status"
          aria-live="polite"
        >${getSaveStatusLabel()}</span>
        <div class="topbar-actions">
          <button
            class="button button-ghost mobile-outline-toggle"
            data-action="toggle-outline"
            aria-controls="outline-panel"
            aria-expanded="${state.outlineOpen ? "true" : "false"}"
            type="button"
          >${state.outlineOpen ? "Hide nodes" : "Nodes"}</button>
          <button class="button button-ghost" data-action="add-root-node" type="button">New root</button>
          <button class="button button-ghost" data-action="trigger-import" type="button">Import</button>
          <button class="button button-ghost" data-action="export-tree" type="button">Export</button>
          <button class="button button-ghost" data-action="open-shortcuts-dialog" type="button">Shortcuts</button>
        </div>
      </header>

      <main class="workspace ${state.outlineOpen ? "is-outline-open" : ""}">
        <button class="outline-scrim" data-action="close-outline" type="button" aria-label="Close node outline"></button>
        <aside class="sidebar-panel" id="outline-panel">
          <div class="panel-header">
            <div>
              <p class="panel-label">Outline</p>
              <h2>Nodes</h2>
            </div>
            <div class="panel-header-actions">
              <p class="panel-meta">${state.tree.length} top-level ${state.tree.length === 1 ? "node" : "nodes"}</p>
              <button class="icon-button outline-close" data-action="close-outline" type="button" aria-label="Close node outline">×</button>
            </div>
          </div>
          ${renderConflictBanner()}
          ${renderDeleteUndoBanner()}
          ${
            state.errorMessage
              ? `<div class="banner banner-error" role="alert"><p>${escapeHtml(state.errorMessage)}</p></div>`
              : ""
          }
          <div class="outline-search">
            <input
              class="outline-search-input"
              data-action="edit-outline-filter"
              type="search"
              aria-label="Search node outline"
              placeholder="Search nodes"
              autocomplete="off"
              spellcheck="false"
              value="${escapeHtml(state.outlineFilter)}"
            />
            <button
              class="icon-button"
              data-action="clear-outline-filter"
              ${state.outlineFilter ? "" : "disabled"}
              aria-label="Clear node search"
              type="button"
            >×</button>
          </div>
          ${
            isFiltered
              ? `<p class="outline-filter-meta">${outlineMatchCount} ${outlineMatchCount === 1 ? "match" : "matches"}</p>`
              : ""
          }
          <div class="tree-list" role="tree" aria-label="Node outline">
            ${renderSidebarRows(sidebarRows, { isFiltered })}
            <div class="tree-end-drop" data-role="sidebar-end-drop"></div>
          </div>
        </aside>

        <section class="detail-panel">
          ${renderDetailContent(selectedNode)}
        </section>
      </main>
      <input id="import-input" class="sr-only" type="file" accept="application/json" aria-label="Import JSON file" />
      ${renderImportDialog()}
      ${renderShortcutsDialog()}
    </div>
  `;
  syncDragDecorations();
  syncSortables();
  focusModalAction();
}

async function request(url, options = {}) {
  const { responseType = "auto", headers = {}, ...fetchOptions } = options;
  const response = await fetch(url, {
    ...fetchOptions,
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
  });

  if (!response.ok) {
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = { error: `Request failed with ${response.status}` };
    }

    const error = new Error(payload.error || "Request failed");
    error.payload = payload;
    error.status = response.status;
    throw error;
  }

  if (responseType === "blob") {
    return response.blob();
  }

  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    return response.json();
  }

  return response.blob();
}

async function loadState() {
  clearRandomPickAnimation();
  setSaveStatus("loading");
  render();

  try {
    const payload = await request("/api/state");
    saveGeneration += 1;
    state.tree = payload.tree;
    state.version = payload.version;
    state.selectedId = deriveSelection(state.tree, state.selectedId);
    setSaveStatus("saved");
    state.errorMessage = "";
    state.conflictState = null;
    state.deleteUndo = null;
    cancelScheduledSave();
  } catch (error) {
    setSaveStatus("error");
    state.errorMessage = error instanceof Error ? error.message : "Failed to load state.";
  }

  render();
}

function queueSave(delay = 400, shouldRender = true, shouldRenderFlush = true) {
  setSaveStatus("dirty");
  if (shouldRender) {
    render();
  }

  if (saveTimer) {
    clearTimeout(saveTimer);
  }

  saveTimer = setTimeout(() => {
    saveTimer = null;
    flushSave({ shouldRender: shouldRenderFlush });
  }, delay);
}

function cancelScheduledSave() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }

  pendingSave = false;
  pendingSaveShouldRender = false;
}

async function flushSave({ shouldRender = true } = {}) {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }

  if (saveInFlight) {
    pendingSave = true;
    pendingSaveShouldRender = pendingSaveShouldRender || shouldRender;
    return;
  }

  saveInFlight = true;
  setSaveStatus("saving");
  state.errorMessage = "";
  if (shouldRender) {
    render();
  }

  const submittedTree = state.tree;
  const submittedVersion = state.version;
  const submittedGeneration = saveGeneration;
  const payload = {
    version: submittedVersion,
    tree: submittedTree,
  };

  try {
    const result = await request("/api/state", {
      method: "PUT",
      body: JSON.stringify(payload),
    });

    if (state.version !== submittedVersion || saveGeneration !== submittedGeneration) {
      return;
    }

    state.version = result.version;
    state.conflictState = null;

    if (state.tree === submittedTree) {
      state.tree = result.tree;
      state.selectedId = deriveSelection(state.tree, state.selectedId);
      setSaveStatus("saved");
    } else {
      setSaveStatus("dirty");
      pendingSave = true;
    }
  } catch (error) {
    if (state.version !== submittedVersion || saveGeneration !== submittedGeneration) {
      return;
    }

    if (error.status === 409 && error.payload?.state) {
      setSaveStatus("conflict");
      state.conflictState = error.payload.state;
      state.errorMessage = "";
    } else {
      setSaveStatus("error");
      state.errorMessage = error instanceof Error ? error.message : "Failed to save.";
    }
  } finally {
    saveInFlight = false;
    if (shouldRender || state.saveStatus === "error" || state.saveStatus === "conflict") {
      render();
    }
    if (pendingSave) {
      const shouldRenderPendingSave = pendingSaveShouldRender;
      pendingSave = false;
      pendingSaveShouldRender = false;
      flushSave({ shouldRender: shouldRenderPendingSave });
    }
  }
}

function commitTree(nextTree, nextSelectedId, saveDelay = 0, { keepDeleteUndo = false } = {}) {
  clearRandomPickAnimation();
  if (!keepDeleteUndo) {
    state.deleteUndo = null;
  }
  state.tree = nextTree;
  state.selectedId = deriveSelection(nextTree, nextSelectedId ?? state.selectedId);
  state.conflictState = null;
  queueSave(saveDelay);
}

function applyDelete(nodeId) {
  clearRandomPickAnimation();
  const node = findNode(state.tree, nodeId);
  if (!node) {
    return;
  }

  state.deleteUndo = createDeleteUndoSnapshot(node.title);
  const result = deleteNode(state.tree, nodeId, state.selectedId);
  commitTree(result.tree, result.nextSelectedId, 0, { keepDeleteUndo: true });
}

function restoreDeleteUndo() {
  if (!state.deleteUndo) {
    return;
  }

  const undo = state.deleteUndo;
  state.deleteUndo = null;
  commitTree(undo.tree, undo.selectedId, 0);
}

function computeSidebarDropPosition(targetRow, clientY) {
  const rect = targetRow.getBoundingClientRect();
  const ratio = (clientY - rect.top) / rect.height;

  if (ratio < 0.28) {
    return "above";
  }

  if (ratio > 0.72) {
    return "below";
  }

  return "inside";
}

function hasRandomPickState() {
  return Boolean(state.randomPick.highlightId || state.randomPick.pickedId);
}

function clearRandomPickAnimation({ shouldRender = false } = {}) {
  randomPickGeneration += 1;
  for (const timer of randomPickTimers) {
    clearTimeout(timer);
  }
  randomPickTimers = [];
  state.randomPick = createEmptyRandomPickState();
  clearRandomPickDecorations();

  if (shouldRender) {
    render();
  }
}

function scheduleRandomTimer(callback, delay) {
  const timer = setTimeout(() => {
    randomPickTimers = randomPickTimers.filter((nextTimer) => nextTimer !== timer);
    callback();
  }, delay);
  randomPickTimers.push(timer);
}

function prefersReducedMotion() {
  return Boolean(globalThis.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches);
}

function dismissTransientState() {
  state.importDialog = null;
  state.shortcutsDialog = false;
  clearRandomPickAnimation();
}

function renderAndFocusComposer() {
  render();
  document.querySelector('[name="composerTitle"]')?.focus();
}

function selectNode(nodeId) {
  state.selectedId = deriveSelection(state.tree, nodeId);
  state.outlineOpen = false;
  dismissTransientState();
  render();
}

function addRootNodeAndFocus() {
  clearRandomPickAnimation();
  const node = createNode({
    title: "New Node",
    kind: "list",
  });

  state.outlineOpen = false;
  commitTree(addRootNode(state.tree, node), node.id, 0);
  focusSelectedTitle();
}

function addChildNodeAndFocus() {
  clearRandomPickAnimation();
  const selectedNode = getSelectedNode();
  if (!selectedNode) {
    addRootNodeAndFocus();
    return;
  }

  const child = createNode({
    title: "New Node",
  });

  commitTree(addChildNode(state.tree, selectedNode.id, child), child.id, 0);
  focusSelectedTitle();
}

function changeNodeWeight(nodeId, delta) {
  clearRandomPickAnimation();
  const node = findNode(state.tree, nodeId);
  if (!node || !Number.isInteger(delta) || delta === 0) {
    return;
  }

  const nextWeight = Math.max(1, Math.min(MAX_NODE_WEIGHT, (node.weight || 1) + delta));
  if (nextWeight === node.weight) {
    return;
  }

  state.deleteUndo = null;
  state.tree = updateNodeWeight(state.tree, nodeId, nextWeight);
  queueSave(0);
}

function openWebsiteForNode(nodeId) {
  const node = findNode(state.tree, nodeId);
  const href = getWebsiteHref(node?.url);

  if (!href) {
    state.errorMessage = "Enter a valid website link before opening it.";
    render();
    return;
  }

  state.errorMessage = "";
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.target = "_blank";
  anchor.rel = "noopener noreferrer";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
}

function getNodeWeight(node) {
  return Number.isSafeInteger(node?.weight) && node.weight > 0 ? node.weight : 1;
}

function pickWeightedChild(children) {
  const totalWeight = children.reduce((total, child) => total + getNodeWeight(child), 0);
  let threshold = Math.random() * totalWeight;

  for (const child of children) {
    threshold -= getNodeWeight(child);
    if (threshold < 0) {
      return child;
    }
  }

  return children[children.length - 1];
}

function finishRandomRowPick(sourceNodeId, pickedId, generation, onComplete) {
  if (generation !== randomPickGeneration || state.selectedId !== sourceNodeId) {
    return;
  }

  // Preserve picked highlight until a new random pick or manual clear
  state.randomPick = {
    highlightId: null,
    pickedId,
  };
  render();

  // Directly invoke completion logic without clearing highlight
  if (onComplete) {
    onComplete();
  }
}

function animateRandomRowPick(sourceNode, pickedNode, onComplete) {
  clearRandomPickAnimation();
  state.outlineOpen = false;

  const childIds = sourceNode.children.map((child) => child.id);
  if (childIds.length === 0) {
    render();
    return;
  }

  randomPickGeneration += 1;
  const generation = randomPickGeneration;

  if (prefersReducedMotion()) {
    finishRandomRowPick(sourceNode.id, pickedNode.id, generation, onComplete);
    return;
  }

  const sequence = childIds.length < 4 ? [...childIds, ...childIds] : childIds;
  sequence.forEach((childId, index) => {
    scheduleRandomTimer(() => {
      if (generation !== randomPickGeneration || state.selectedId !== sourceNode.id) {
        return;
      }

      state.randomPick = {
        highlightId: childId,
        pickedId: null,
      };
      render();
    }, index * RANDOM_ROW_STEP_MS);
  });

  scheduleRandomTimer(
    () => finishRandomRowPick(sourceNode.id, pickedNode.id, generation, onComplete),
    sequence.length * RANDOM_ROW_STEP_MS,
  );
}

function flashPickedRow(nodeId) {
  clearRandomPickAnimation();
  randomPickGeneration += 1;
  const generation = randomPickGeneration;
  state.randomPick = {
    highlightId: null,
    pickedId: nodeId,
  };
  render();

  scheduleRandomTimer(() => {
    if (generation !== randomPickGeneration) {
      return;
    }

    state.randomPick = createEmptyRandomPickState();
    render();
  }, prefersReducedMotion() ? 120 : RANDOM_ROW_FLASH_MS);
}

function pickRandomChild(nodeId) {
  const selectedNode = findNode(state.tree, nodeId);
  if (!selectedNode || selectedNode.children.length === 0) {
    return;
  }

  const pick = pickWeightedChild(selectedNode.children);
  const onlyLeafChild = pick.children.length === 1 && !nodeHasChildren(pick.children[0])
    ? pick.children[0]
    : null;

  animateRandomRowPick(selectedNode, pick, () => {
    state.selectedId = pick.id;
    // Render to reflect the new selection (open the picked node)
    render();
    if (onlyLeafChild) {
      flashPickedRow(onlyLeafChild.id);
    }
  });
}

function handleAction(target) {
  if (!(target instanceof Element)) {
    return;
  }

  const actionSource = target.closest("[data-action]");
  if (!actionSource) {
    return;
  }

  if (actionSource.classList.contains("modal-backdrop") && target.closest(".modal-card")) {
    return;
  }

  const action = actionSource.dataset.action;
  const nodeId = actionSource.dataset.nodeId || null;

  switch (action) {
    case "add-root-node": {
      addRootNodeAndFocus();
      return;
    }
    case "add-child-node": {
      const child = createNode({ title: "New Node" });
      commitTree(addChildNode(state.tree, nodeId, child), nodeId, 0);
      return;
    }
    case "delete-node": {
      applyDelete(nodeId);
      return;
    }
    case "change-weight": {
      changeNodeWeight(nodeId, Number(actionSource.dataset.delta));
      return;
    }
    case "toggle-expand": {
      clearRandomPickAnimation();
      state.deleteUndo = null;
      state.tree = toggleNodeExpanded(state.tree, nodeId);
      render();
      queueSave(0, false);
      return;
    }
    case "undo-delete": {
      restoreDeleteUndo();
      return;
    }
    case "dismiss-delete-undo": {
      state.deleteUndo = null;
      render();
      return;
    }
    case "open-url": {
      openWebsiteForNode(nodeId);
      return;
    }
    case "select-node":
    case "open-node": {
      selectNode(nodeId);
      return;
    }
    case "pick-random": {
      pickRandomChild(nodeId);
      return;
    }
    case "toggle-outline": {
      state.outlineOpen = !state.outlineOpen;
      render();
      return;
    }
    case "close-outline": {
      state.outlineOpen = false;
      render();
      return;
    }
    case "clear-outline-filter": {
      state.outlineFilter = "";
      render();
      document.querySelector(".outline-search-input")?.focus();
      return;
    }
    case "trigger-import": {
      document.querySelector("#import-input")?.click();
      return;
    }
    case "close-import-dialog": {
      state.importDialog = null;
      render();
      return;
    }
    case "open-shortcuts-dialog": {
      state.shortcutsDialog = true;
      render();
      return;
    }
    case "close-shortcuts-dialog": {
      state.shortcutsDialog = false;
      render();
      return;
    }
    case "confirm-import": {
      if (!state.importDialog) {
        return;
      }

      importTree(actionSource.dataset.mode || "replace");
      return;
    }
    case "export-tree": {
      exportTree();
      return;
    }
    case "reload-server-state": {
      loadState();
      return;
    }
    case "overwrite-server-state": {
      if (!state.conflictState) {
        return;
      }
      state.version = state.conflictState.version;
      state.conflictState = null;
      state.deleteUndo = null;
      flushSave();
      return;
    }
    default:
      break;
  }
}

function isTypingTarget(target) {
  if (!(target instanceof Element)) {
    return false;
  }

  return target.matches("input, textarea, select") || target.isContentEditable;
}

function isPlainShortcut(event) {
  return !event.altKey && !event.ctrlKey && !event.metaKey;
}

function handleInput(event) {
  const target = event.target;
  if (!(target instanceof Element)) {
    return;
  }

  if (target.matches('[data-action="edit-outline-filter"]')) {
    const caretPosition = target instanceof HTMLInputElement
      ? target.selectionStart ?? target.value.length
      : null;

    state.outlineFilter = target.value;
    render();

    const searchInput = document.querySelector(".outline-search-input");
    if (searchInput instanceof HTMLInputElement) {
      searchInput.focus();
      if (caretPosition !== null) {
        searchInput.setSelectionRange(caretPosition, caretPosition);
      }
    }
    return;
  }

  if (target.matches('[data-action="edit-title"]')) {
    state.deleteUndo = null;
    state.tree = updateNodeTitle(state.tree, target.dataset.nodeId, target.value);
    setSaveStatus("dirty");
    queueSave(600, false, false);
    return;
  }

  if (target.matches('[data-action="edit-url"]')) {
    state.deleteUndo = null;
    state.tree = updateNodeUrl(state.tree, target.dataset.nodeId, target.value);
    syncWebsiteButtons(target.dataset.nodeId);
    setSaveStatus("dirty");
    queueSave(600, false, false);
    return;
  }

  if (target.name === "composerTitle") {
    state.composerTitle = target.value;
  }

  if (target.name === "composerUrl") {
    state.composerUrl = target.value;
  }
}

function handleChange(event) {
  const target = event.target;
  if (!(target instanceof Element)) {
    return;
  }

  if (target.matches('[data-action="edit-title"]')) {
    if (state.saveStatus === "dirty") {
      queueSave(150, false);
    }
    return;
  }

  if (target.matches('[data-action="edit-url"]')) {
    if (state.saveStatus === "dirty") {
      queueSave(150, false);
    }
    return;
  }

  if (target.id === "import-input") {
    const [file] = target.files || [];
    if (!file) {
      return;
    }

    file.text()
      .then((text) => {
        state.importDialog = {
          fileName: file.name,
          text,
        };
        target.value = "";
        render();
      })
      .catch((error) => {
        state.errorMessage = error instanceof Error ? error.message : "Failed to read import file.";
        render();
      });
  }
}

function handleSubmit(event) {
  const form = event.target;
  if (!(form instanceof Element)) {
    return;
  }

  if (!form.matches('[data-action="submit-composer"]')) {
    return;
  }

  event.preventDefault();
  const selectedNode = getSelectedNode();

  if (!selectedNode) {
    return;
  }

  const titles = getComposerTitles();
  if (titles.length === 0) {
    return;
  }

  const sharedUrl = titles.length === 1 ? state.composerUrl : "";
  let nextTree = state.tree;
  for (const title of titles) {
    const nextNode = createNode({
      title,
      url: sharedUrl,
    });
    nextTree = addChildNode(nextTree, selectedNode.id, nextNode);
  }

  commitTree(nextTree, selectedNode.id, 0);
  state.composerTitle = "";
  state.composerUrl = "";
  renderAndFocusComposer();
}

function handleComposerKeydown(event) {
  const target = event.target;
  if (
    !(target instanceof HTMLTextAreaElement)
    || target.name !== "composerTitle"
    || event.key !== "Enter"
    || event.shiftKey
    || event.isComposing
  ) {
    return;
  }

  const form = target.closest("form");
  if (!form) {
    return;
  }

  event.preventDefault();
  form.requestSubmit();
}

async function importTree(mode) {
  if (!state.importDialog) {
    return;
  }

  try {
    clearRandomPickAnimation();
    const payload = JSON.parse(state.importDialog.text);
    const result = await request(`/api/import?mode=${mode}`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
    saveGeneration += 1;
    state.tree = result.tree;
    state.version = result.version;
    state.selectedId = deriveSelection(state.tree, getFirstRootId(state.tree));
    state.importDialog = null;
    setSaveStatus("saved");
    state.errorMessage = "";
    state.conflictState = null;
    state.deleteUndo = null;
    cancelScheduledSave();
    render();
  } catch (error) {
    state.errorMessage = error instanceof Error ? error.message : "Failed to import JSON.";
    render();
  }
}

function exportTree() {
  try {
    const exportJson = JSON.stringify(exportToSwiftTree(state.tree), null, 2);
    const blob = new Blob([exportJson], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "randompick-export.json";
    document.body.append(anchor);
    anchor.click();
    setTimeout(() => {
      URL.revokeObjectURL(url);
      anchor.remove();
    }, 0);
  } catch (error) {
    state.errorMessage = error instanceof Error ? error.message : "Failed to export JSON.";
    render();
  }
}

app.addEventListener("click", (event) => {
  handleAction(event.target);
});
app.addEventListener("input", handleInput);
app.addEventListener("change", handleChange);
app.addEventListener("keydown", handleComposerKeydown);
app.addEventListener("submit", handleSubmit);

window.addEventListener("keydown", (event) => {
  if (event.defaultPrevented) {
    return;
  }

  const key = event.key.toLowerCase();
  const commandKey = event.metaKey || event.ctrlKey;

  if (event.key === "Escape") {
    if (state.importDialog) {
      event.preventDefault();
      state.importDialog = null;
      render();
      return;
    }

    if (state.shortcutsDialog) {
      event.preventDefault();
      state.shortcutsDialog = false;
      render();
      return;
    }

    if (hasRandomPickState()) {
      event.preventDefault();
      clearRandomPickAnimation({ shouldRender: true });
      return;
    }

    if (state.deleteUndo) {
      event.preventDefault();
      state.deleteUndo = null;
      render();
      return;
    }

    if (state.outlineFilter) {
      event.preventDefault();
      state.outlineFilter = "";
      render();
      return;
    }

    if (state.outlineOpen) {
      event.preventDefault();
      state.outlineOpen = false;
      render();
      return;
    }
  }

  if (state.importDialog || state.shortcutsDialog) {
    return;
  }

  if (commandKey && key === "z" && state.deleteUndo && !isTypingTarget(event.target)) {
    event.preventDefault();
    restoreDeleteUndo();
    return;
  }

  if (commandKey && key === "s") {
    event.preventDefault();
    flushSave({ shouldRender: false });
    return;
  }

  if (isTypingTarget(event.target)) {
    return;
  }

  if (commandKey && key === "r") {
    event.preventDefault();
    pickRandomChild(state.selectedId);
    return;
  }

  if (commandKey && key === "1") {
    event.preventDefault();
    setSelectionAndFocus(getFirstRootId(state.tree));
    return;
  }

  if (commandKey && key === "o") {
    event.preventDefault();
    document.querySelector("#import-input")?.click();
    return;
  }

  if (commandKey && key === "e") {
    event.preventDefault();
    exportTree();
    return;
  }

  if (!isPlainShortcut(event)) {
    return;
  }

  if (event.key === "?" || (event.shiftKey && event.key === "/")) {
    event.preventDefault();
    state.shortcutsDialog = true;
    render();
    return;
  }

  if (event.key === "ArrowDown") {
    event.preventDefault();
    selectVisibleRow(1);
    return;
  }

  if (event.key === "ArrowUp") {
    event.preventDefault();
    selectVisibleRow(-1);
    return;
  }

  if (event.key === "ArrowLeft" && event.shiftKey) {
    event.preventDefault();
    moveSelectionToCurrentRoot();
    return;
  }

  if (event.key === "ArrowLeft") {
    event.preventDefault();
    navigateLeft();
    return;
  }

  if (event.key === "ArrowRight") {
    event.preventDefault();
    navigateRight();
    return;
  }

  if (event.key === "Home") {
    event.preventDefault();
    moveSelectionHome();
    return;
  }

  if (event.key === "End") {
    event.preventDefault();
    moveSelectionEnd();
    return;
  }

  if (event.repeat) {
    return;
  }

  if (key === "n") {
    event.preventDefault();
    if (event.shiftKey) {
      addRootNodeAndFocus();
    } else {
      addChildNodeAndFocus();
    }
    return;
  }

  if (key === "e") {
    event.preventDefault();
    moveSelectionToCurrentRoot();
    return;
  }

  if (key === "f") {
    event.preventDefault();
    focusOutlineFilter();
    return;
  }

  if (event.key === "/") {
    event.preventDefault();
    focusComposerInput();
    return;
  }

  if (event.key === "Delete") {
    event.preventDefault();
    if (state.selectedId) {
      applyDelete(state.selectedId);
      focusTreeSelection();
    }
    return;
  }

  if (key === "r") {
    event.preventDefault();
    pickRandomChild(state.selectedId);
  }
});

document.addEventListener("visibilitychange", () => {
  if (document.hidden && state.saveStatus === "dirty") {
    flushSave();
  }
});
render();
loadState();
