import Sortable from "/vendor/sortablejs.js";
import {
  addChildNode,
  createNode,
  deleteNode,
  deriveSelection,
  findNode,
  findParentId,
  findPath,
  flattenVisibleTree,
  getFirstRootId,
  moveNodeRelative,
  moveNodeToContainerEnd,
  moveNodeToParent,
  toggleNodeExpanded,
  updateNodeTitle,
} from "/shared/tree.js";

const app = document.querySelector("#app");

function createEmptyDragState() {
  return {
    nodeId: null,
    scope: null,
    targetId: null,
    position: null,
    targetIndex: null,
  };
}

const state = {
  tree: [],
  version: 0,
  selectedId: null,
  saveStatus: "loading",
  errorMessage: "",
  composerTitle: "",
  importDialog: null,
  randomResult: null,
  drag: createEmptyDragState(),
  conflictState: null,
};

let saveTimer = null;
let saveInFlight = false;
let pendingSave = false;
let sidebarSortable = null;
let detailSortable = null;
const dragDecorationClasses = [
  "is-dragging",
  "is-drop-above",
  "is-drop-inside",
  "is-drop-below",
  "is-drop-before",
  "is-drop-invalid",
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

function applyAppearance() {
  document.documentElement.dataset.theme = "dark";
}

function saveStatusLabel() {
  switch (state.saveStatus) {
    case "dirty":
      return "Unsaved";
    case "saving":
      return "Saving...";
    case "error":
      return "Save error";
    case "conflict":
      return "Save conflict";
    case "loading":
      return "Loading...";
    default:
      return "Saved";
  }
}

function getVisibleRows() {
  return flattenVisibleTree(state.tree);
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

function getDataSelector(value) {
  return globalThis.CSS?.escape ? CSS.escape(value) : value.replaceAll('"', '\\"');
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
  if (!state.importDialog && !state.randomResult) {
    return;
  }

  document.querySelector(".modal-card [data-autofocus]")?.focus();
}

function focusTreeSelection() {
  document.querySelector('[data-action="select-node"][aria-current="true"]')?.focus();
}

function selectVisibleRow(offset) {
  const rows = getVisibleRows();
  const currentIndex = rows.findIndex(({ node }) => node.id === state.selectedId);
  if (currentIndex === -1) {
    return;
  }

  const nextRow = rows[currentIndex + offset];
  if (!nextRow) {
    return;
  }

  state.selectedId = nextRow.node.id;
  render();
  focusTreeSelection();
}

function moveSelectionHome() {
  const firstVisible = getVisibleRows()[0];
  if (!firstVisible) {
    return;
  }

  state.selectedId = firstVisible.node.id;
  render();
  focusTreeSelection();
}

function moveSelectionEnd() {
  const rows = getVisibleRows();
  const lastVisible = rows[rows.length - 1];
  if (!lastVisible) {
    return;
  }

  state.selectedId = lastVisible.node.id;
  render();
  focusTreeSelection();
}

function navigateLeft() {
  const selectedNode = getSelectedNode();
  if (!selectedNode) {
    return;
  }

  if (nodeHasChildren(selectedNode) && selectedNode.isExpanded) {
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

  state.selectedId = parentId;
  render();
  focusTreeSelection();
}

function navigateRight() {
  const selectedNode = getSelectedNode();
  if (!selectedNode || !nodeHasChildren(selectedNode)) {
    return;
  }

  if (!selectedNode.isExpanded) {
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

  state.selectedId = firstChildId;
  render();
  focusTreeSelection();
}

function renderSidebarRows(rows) {
  if (rows.length === 0) {
    return `
      <div class="sidebar-empty">
        <p>No nodes yet.</p>
        <p>Import a JSON export to get started.</p>
      </div>
    `;
  }

  return rows
    .map(({ node, depth }) => {
      const classes = [
        "tree-row",
        isSelected(node.id) ? "is-selected" : "",
      ]
        .filter(Boolean)
        .join(" ");
      const canExpand = nodeHasChildren(node);

      return `
        <div
          class="${classes}"
          data-role="sidebar-row"
          data-node-id="${node.id}"
          role="treeitem"
          aria-level="${depth + 1}"
          aria-selected="${isSelected(node.id) ? "true" : "false"}"
          ${canExpand ? `aria-expanded="${node.isExpanded ? "true" : "false"}"` : ""}
          style="--depth:${depth};"
        >
          <button
            class="tree-grip"
            data-role="sidebar-handle"
            data-node-id="${node.id}"
            aria-label="Drag to move ${escapeHtml(node.title)}"
            type="button"
          >⋮⋮</button>
          <button
            class="tree-toggle"
            data-action="toggle-expand"
            data-node-id="${node.id}"
            ${canExpand ? "" : "disabled"}
            aria-label="${canExpand && node.isExpanded ? "Collapse" : "Expand"}"
            aria-hidden="${canExpand ? "false" : "true"}"
            type="button"
          >
            ${canExpand ? (node.isExpanded ? "▾" : "▸") : ""}
          </button>
          <button
            class="tree-main"
            data-action="select-node"
            data-node-id="${node.id}"
            aria-current="${isSelected(node.id) ? "true" : "false"}"
            aria-label="Select ${escapeHtml(node.title)}"
            type="button"
          >
            <span class="tree-title">${escapeHtml(node.title)}</span>
          </button>
          <div class="tree-actions">
            <button class="icon-button" data-action="add-child-node" data-node-id="${node.id}" aria-label="Add child node inside ${escapeHtml(node.title)}" type="button">+</button>
            <button class="icon-button" data-action="delete-node" data-node-id="${node.id}" aria-label="Delete ${escapeHtml(node.title)}" type="button">×</button>
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
        <p>Select a node from the sidebar.</p>
      </section>
    `;
  }

  const path = findPath(state.tree, selectedNode.id)
    .map((node) => escapeHtml(node.title))
    .join(" / ");

  const children = selectedNode.children;
  const rows = children.length
    ? children
        .map((child, index) => {
          return `
            <div
              class="detail-row"
              data-role="detail-row"
              data-node-id="${child.id}"
              data-index="${index}"
              role="listitem"
            >
              <button
                class="drag-handle"
                data-role="detail-handle"
                data-node-id="${child.id}"
                data-index="${index}"
                aria-label="Drag to reorder ${escapeHtml(child.title)}"
                type="button"
              >⋮⋮</button>
              <input
                class="detail-input"
                data-action="edit-title"
                data-node-id="${child.id}"
                aria-label="Child node title"
                value="${escapeHtml(child.title)}"
              />
              <button class="button button-ghost" data-action="open-node" data-node-id="${child.id}" type="button">Open</button>
              <button class="button button-ghost" data-action="delete-node" data-node-id="${child.id}" type="button">Delete</button>
            </div>
          `;
        })
        .join("")
    : `
        <div class="empty-list">
          <p>This node has no child nodes yet.</p>
          <p>Add one below or drop another node into it.</p>
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
              data-node-id="${selectedNode.id}"
              aria-label="Selected node title"
              value="${escapeHtml(selectedNode.title)}"
            />
          </div>
          <p class="detail-meta">
            ${children.length} child ${children.length === 1 ? "node" : "nodes"}
          </p>
        </div>
        <div class="detail-header-actions">
          <button class="button button-primary" data-action="pick-random" data-node-id="${selectedNode.id}" ${children.length === 0 ? "disabled" : ""} type="button">Pick Random</button>
          ${
            findParentId(state.tree, selectedNode.id)
              ? `<button class="button button-ghost" data-action="select-node" data-node-id="${findParentId(state.tree, selectedNode.id)}" type="button">Back to Parent</button>`
              : ""
          }
        </div>
      </div>

      <div class="detail-list" role="list" aria-label="Child nodes">
        ${rows}
      </div>

      <form class="composer" data-action="submit-composer">
        <input
          class="composer-input"
          name="composerTitle"
          aria-label="New child node title"
          placeholder="Add a node..."
          value="${escapeHtml(state.composerTitle)}"
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
        <p>The file is loaded. Choose whether to replace the current document or merge the imported roots into it.</p>
        <div class="modal-actions">
          <button class="button button-primary" data-action="confirm-import" data-mode="replace" data-autofocus type="button">Replace Current Data</button>
          <button class="button button-ghost" data-action="confirm-import" data-mode="merge" type="button">Merge Imported Roots</button>
          <button class="button button-ghost" data-action="close-import-dialog" type="button">Cancel</button>
        </div>
      </div>
    </div>
  `;
}

function renderRandomResult() {
  if (!state.randomResult) {
    return "";
  }

  return `
    <div class="modal-backdrop" data-action="dismiss-random-result">
      <div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="random-title">
        <h2 id="random-title">Random Pick</h2>
        <p>${escapeHtml(state.randomResult.message)}</p>
        <div class="modal-actions">
          <button class="button button-primary" data-action="dismiss-random-result" data-autofocus type="button">Close</button>
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
        <button class="button button-primary" data-action="reload-server-state" type="button">Reload Server Copy</button>
        <button class="button button-ghost" data-action="overwrite-server-state" type="button">Overwrite With Local Copy</button>
      </div>
    </div>
  `;
}

function render() {
  applyAppearance();
  const sidebarRows = getVisibleRows();
  const selectedNode = getSelectedNode();

  app.innerHTML = `
    <div class="shell">
      <header class="topbar">
        <div class="brand-block">
          <h1>RandomPick</h1>
        </div>
        <div class="topbar-actions">
          <button class="button button-ghost" data-action="trigger-import" type="button">Import</button>
          <button class="button button-ghost" data-action="export-tree" type="button">Export</button>
          <div class="save-pill" data-status="${state.saveStatus}" role="status" aria-live="polite" aria-atomic="true">${saveStatusLabel()}</div>
        </div>
      </header>

      <main class="workspace">
        <aside class="sidebar-panel">
          <div class="panel-header">
            <div>
              <p class="panel-label">Outline</p>
              <h2>Nodes</h2>
            </div>
            <p class="panel-meta">${state.tree.length} top-level ${state.tree.length === 1 ? "node" : "nodes"}</p>
          </div>
          ${renderConflictBanner()}
          ${
            state.errorMessage
              ? `<div class="banner banner-error" role="alert"><p>${escapeHtml(state.errorMessage)}</p></div>`
              : ""
          }
          <div class="tree-list" role="tree" aria-label="Node outline">
            ${renderSidebarRows(sidebarRows)}
            <div class="tree-end-drop" data-role="sidebar-end-drop"></div>
          </div>
        </aside>

        <section class="detail-panel">
          ${renderDetailContent(selectedNode)}
        </section>
      </main>
      <input id="import-input" class="sr-only" type="file" accept="application/json" aria-label="Import JSON file" />
      ${renderImportDialog()}
      ${renderRandomResult()}
    </div>
  `;
  syncDragDecorations();
  syncSortables();
  focusModalAction();
}

async function request(url, options = {}) {
  const response = await fetch(url, {
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
    ...options,
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

  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    return response.json();
  }

  return response.blob();
}

async function loadState() {
  state.saveStatus = "loading";
  render();

  try {
    const payload = await request("/api/state");
    state.tree = payload.tree;
    state.version = payload.version;
    state.selectedId = deriveSelection(state.tree, state.selectedId);
    state.saveStatus = "saved";
    state.errorMessage = "";
  } catch (error) {
    state.saveStatus = "error";
    state.errorMessage = error instanceof Error ? error.message : "Failed to load state.";
  }

  render();
}

function queueSave(delay = 400, shouldRender = true) {
  state.saveStatus = "dirty";
  if (shouldRender) {
    render();
  }

  if (saveTimer) {
    clearTimeout(saveTimer);
  }

  saveTimer = setTimeout(() => {
    saveTimer = null;
    flushSave();
  }, delay);
}

async function flushSave() {
  if (saveInFlight) {
    pendingSave = true;
    return;
  }

  saveInFlight = true;
  state.saveStatus = "saving";
  state.errorMessage = "";
  render();

  const payload = {
    version: state.version,
    tree: state.tree,
  };

  try {
    const result = await request("/api/state", {
      method: "PUT",
      body: JSON.stringify(payload),
    });
    state.version = result.version;
    state.saveStatus = "saved";
    state.conflictState = null;
  } catch (error) {
    if (error.status === 409 && error.payload?.state) {
      state.saveStatus = "conflict";
      state.conflictState = error.payload.state;
      state.errorMessage = "";
    } else {
      state.saveStatus = "error";
      state.errorMessage = error instanceof Error ? error.message : "Failed to save.";
    }
  } finally {
    saveInFlight = false;
    render();
    if (pendingSave) {
      pendingSave = false;
      flushSave();
    }
  }
}

function commitTree(nextTree, nextSelectedId, saveDelay = 0) {
  state.tree = nextTree;
  state.selectedId = deriveSelection(nextTree, nextSelectedId ?? state.selectedId);
  state.conflictState = null;
  queueSave(saveDelay);
}

function applyDelete(nodeId) {
  const result = deleteNode(state.tree, nodeId, state.selectedId);
  commitTree(result.tree, result.nextSelectedId, 0);
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

function dismissTransientState() {
  state.importDialog = null;
  state.randomResult = null;
}

function renderAndFocusComposer() {
  render();
  document.querySelector(".composer-input")?.focus();
}

function selectNode(nodeId) {
  state.selectedId = deriveSelection(state.tree, nodeId);
  dismissTransientState();
  render();
}

function handleAction(target) {
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
    case "add-child-node": {
      const child = createNode({ title: "New Node" });
      commitTree(addChildNode(state.tree, nodeId, child), nodeId, 0);
      return;
    }
    case "delete-node": {
      applyDelete(nodeId);
      return;
    }
    case "toggle-expand": {
      state.tree = toggleNodeExpanded(state.tree, nodeId);
      render();
      queueSave(0, false);
      return;
    }
    case "select-node":
    case "open-node": {
      selectNode(nodeId);
      return;
    }
    case "pick-random": {
      const selectedNode = findNode(state.tree, nodeId);
      if (!selectedNode || selectedNode.children.length === 0) {
        return;
      }

      const pick = selectedNode.children[Math.floor(Math.random() * selectedNode.children.length)];
      if (nodeHasChildren(pick)) {
        state.selectedId = pick.id;
      } else {
        state.randomResult = {
          message: pick.title,
        };
      }
      render();
      return;
    }
    case "dismiss-random-result": {
      state.randomResult = null;
      render();
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
      flushSave();
      return;
    }
    default:
      break;
  }
}

function handleInput(event) {
  const target = event.target;

  if (target.matches('[data-action="edit-title"]')) {
    state.tree = updateNodeTitle(state.tree, target.dataset.nodeId, target.value);
    state.saveStatus = "dirty";
    return;
  }

  if (target.name === "composerTitle") {
    state.composerTitle = target.value;
  }
}

function handleChange(event) {
  const target = event.target;

  if (target.matches('[data-action="edit-title"]')) {
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
  if (!form.matches('[data-action="submit-composer"]')) {
    return;
  }

  event.preventDefault();
  const selectedNode = getSelectedNode();

  if (!selectedNode) {
    return;
  }

  const title = state.composerTitle.trim();
  if (!title) {
    return;
  }

  const nextNode = createNode({
    title,
  });

  commitTree(addChildNode(state.tree, selectedNode.id, nextNode), selectedNode.id, 0);
  state.composerTitle = "";
  renderAndFocusComposer();
}

async function importTree(mode) {
  if (!state.importDialog) {
    return;
  }

  try {
    const payload = JSON.parse(state.importDialog.text);
    const result = await request(`/api/import?mode=${mode}`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
    state.tree = result.tree;
    state.version = result.version;
    state.selectedId = deriveSelection(state.tree, getFirstRootId(state.tree));
    state.importDialog = null;
    state.saveStatus = "saved";
    state.errorMessage = "";
    render();
  } catch (error) {
    state.errorMessage = error instanceof Error ? error.message : "Failed to import JSON.";
    render();
  }
}

async function exportTree() {
  try {
    const blob = await request("/api/export", {
      headers: {
        "Content-Type": "application/json",
      },
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "randompick-export.json";
    anchor.click();
    URL.revokeObjectURL(url);
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
app.addEventListener("submit", handleSubmit);

window.addEventListener("keydown", (event) => {
  if (event.defaultPrevented) {
    return;
  }

  if (event.key === "Escape") {
    if (state.importDialog) {
      event.preventDefault();
      state.importDialog = null;
      render();
      return;
    }

    if (state.randomResult) {
      event.preventDefault();
      state.randomResult = null;
      render();
      return;
    }
  }

  if (state.importDialog || state.randomResult) {
    return;
  }

  const activeTag = document.activeElement?.tagName || "";
  const typing = ["INPUT", "TEXTAREA", "SELECT"].includes(activeTag);

  if (typing) {
    return;
  }

  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "r") {
    event.preventDefault();
    const selectedNode = getSelectedNode();
    if (selectedNode && selectedNode.children.length > 0) {
      const button = document.querySelector('[data-action="pick-random"]');
      if (button) {
        button.click();
      }
    }
    return;
  }

  if ((event.metaKey || event.ctrlKey) && event.key === "1") {
    event.preventDefault();
    state.selectedId = getFirstRootId(state.tree);
    render();
    focusTreeSelection();
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
  }
});

document.addEventListener("visibilitychange", () => {
  if (document.hidden && state.saveStatus === "dirty") {
    flushSave();
  }
});
render();
loadState();
