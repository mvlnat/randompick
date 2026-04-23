import {
  addChildNode,
  addRootNode,
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
const systemThemeQuery = window.matchMedia("(prefers-color-scheme: dark)");

const state = {
  tree: [],
  version: 0,
  selectedId: null,
  saveStatus: "loading",
  errorMessage: "",
  appearance: localStorage.getItem("randompick:appearance") || "system",
  composerTitle: "",
  composerKind: "item",
  importDialog: null,
  randomResult: null,
  drag: {
    nodeId: null,
    scope: null,
    targetId: null,
    position: null,
    targetIndex: null,
  },
  conflictState: null,
};

let saveTimer = null;
let saveInFlight = false;
let pendingSave = false;

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function setAppearance(mode) {
  state.appearance = mode;
  localStorage.setItem("randompick:appearance", mode);
  applyAppearance();
}

function applyAppearance() {
  const resolvedTheme =
    state.appearance === "system"
      ? (systemThemeQuery.matches ? "dark" : "light")
      : state.appearance;

  document.documentElement.dataset.theme = resolvedTheme;
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

function getSelectedNode() {
  return state.selectedId ? findNode(state.tree, state.selectedId) : null;
}

function isSelected(nodeId) {
  return state.selectedId === nodeId;
}

function isDropTarget(nodeId, position) {
  return state.drag.targetId === nodeId && state.drag.position === position;
}

function isDropInvalid(nodeId) {
  if (!state.drag.nodeId) {
    return false;
  }

  if (state.drag.nodeId === nodeId) {
    return true;
  }

  const dragged = findNode(state.tree, state.drag.nodeId);
  const target = findNode(state.tree, nodeId);

  if (!dragged || !target) {
    return false;
  }

  return dragged.id === target.id || findPath([dragged], nodeId).length > 0;
}

function renderSidebarRows(rows) {
  if (rows.length === 0) {
    return `
      <div class="sidebar-empty">
        <p>No lists yet.</p>
        <button class="button button-primary" data-action="add-root">Create your first list</button>
      </div>
    `;
  }

  return rows
    .map(({ node, depth }) => {
      const classes = [
        "tree-row",
        isSelected(node.id) ? "is-selected" : "",
        state.drag.nodeId === node.id ? "is-dragging" : "",
        isDropTarget(node.id, "above") ? "is-drop-above" : "",
        isDropTarget(node.id, "inside") ? "is-drop-inside" : "",
        isDropTarget(node.id, "below") ? "is-drop-below" : "",
        isDropInvalid(node.id) ? "is-drop-invalid" : "",
      ]
        .filter(Boolean)
        .join(" ");

      return `
        <div
          class="${classes}"
          draggable="true"
          data-role="sidebar-row"
          data-node-id="${node.id}"
          style="--depth:${depth};"
        >
          <button
            class="tree-toggle"
            data-action="toggle-expand"
            data-node-id="${node.id}"
            ${node.kind !== "list" ? "disabled" : ""}
            aria-label="${node.kind === "list" && node.isExpanded ? "Collapse" : "Expand"}"
          >
            ${node.kind === "list" ? (node.isExpanded ? "▾" : "▸") : "·"}
          </button>
          <button class="tree-main" data-action="select-node" data-node-id="${node.id}">
            <span class="tree-icon">${node.kind === "list" ? "□" : "○"}</span>
            <span class="tree-title">${escapeHtml(node.title)}</span>
          </button>
          <div class="tree-actions">
            <button class="icon-button" data-action="add-child-list" data-node-id="${node.id}" aria-label="Add child list">+</button>
            <button class="icon-button" data-action="delete-node" data-node-id="${node.id}" aria-label="Delete node">×</button>
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
        <p>Select a list from the sidebar or create a new one.</p>
      </section>
    `;
  }

  const path = findPath(state.tree, selectedNode.id)
    .map((node) => escapeHtml(node.title))
    .join(" / ");

  const children = selectedNode.kind === "list" ? selectedNode.children : [];
  const rows = children.length
    ? children
        .map((child, index) => {
          const isDragging = state.drag.scope === "detail" && state.drag.nodeId === child.id;
          const dropClasses = [
            state.drag.scope === "detail" && state.drag.targetIndex === index ? "is-drop-before" : "",
            isDragging ? "is-dragging" : "",
          ]
            .filter(Boolean)
            .join(" ");

          return `
            <div
              class="detail-row ${dropClasses}"
              draggable="true"
              data-role="detail-row"
              data-node-id="${child.id}"
              data-index="${index}"
            >
              <span class="drag-handle">⋮⋮</span>
              <span class="detail-kind">${child.kind === "list" ? "List" : "Item"}</span>
              <input
                class="detail-input"
                data-action="edit-title"
                data-node-id="${child.id}"
                value="${escapeHtml(child.title)}"
              />
              ${
                child.kind === "list"
                  ? `<button class="button button-ghost" data-action="open-node" data-node-id="${child.id}">Open</button>`
                  : ""
              }
              <button class="button button-ghost" data-action="delete-node" data-node-id="${child.id}">Delete</button>
            </div>
          `;
        })
        .join("")
    : `
        <div class="empty-list">
          <p>This list is empty.</p>
          <p>Add an item or a sublist below.</p>
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
              value="${escapeHtml(selectedNode.title)}"
            />
            <span class="detail-kind-badge">${selectedNode.kind}</span>
          </div>
          <p class="detail-meta">
            ${
              selectedNode.kind === "list"
                ? `${children.length} child ${children.length === 1 ? "node" : "nodes"}`
                : `Child of ${escapeHtml(findNode(state.tree, findParentId(state.tree, selectedNode.id))?.title || "root")}`
            }
          </p>
        </div>
        <div class="detail-header-actions">
          ${
            selectedNode.kind === "list"
              ? `<button class="button button-primary" data-action="pick-random" data-node-id="${selectedNode.id}" ${children.length === 0 ? "disabled" : ""}>Pick Random</button>`
              : ""
          }
          ${
            findParentId(state.tree, selectedNode.id)
              ? `<button class="button button-ghost" data-action="select-node" data-node-id="${findParentId(state.tree, selectedNode.id)}">Back to Parent</button>`
              : ""
          }
        </div>
      </div>

      ${
        selectedNode.kind === "list"
          ? `
            <div class="detail-list">
              ${rows}
              <div class="detail-end-drop ${state.drag.scope === "detail" && state.drag.targetIndex === children.length ? "is-drop-before" : ""}" data-role="detail-end-drop" data-parent-id="${selectedNode.id}" data-index="${children.length}"></div>
            </div>

            <form class="composer" data-action="submit-composer">
              <input
                class="composer-input"
                name="composerTitle"
                placeholder="Add a new child..."
                value="${escapeHtml(state.composerTitle)}"
              />
              <select class="composer-select" name="composerKind">
                <option value="item" ${state.composerKind === "item" ? "selected" : ""}>Item</option>
                <option value="list" ${state.composerKind === "list" ? "selected" : ""}>List</option>
              </select>
              <button class="button button-primary" type="submit">Add</button>
            </form>
          `
          : ""
      }
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
          <button class="button button-primary" data-action="confirm-import" data-mode="replace">Replace Current Data</button>
          <button class="button button-ghost" data-action="confirm-import" data-mode="merge">Merge Imported Roots</button>
          <button class="button button-ghost" data-action="close-import-dialog">Cancel</button>
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
          <button class="button button-primary" data-action="dismiss-random-result">Close</button>
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
    <div class="banner banner-warning">
      <p>Your local copy differs from a newer server version.</p>
      <div class="banner-actions">
        <button class="button button-primary" data-action="reload-server-state">Reload Server Copy</button>
        <button class="button button-ghost" data-action="overwrite-server-state">Overwrite With Local Copy</button>
      </div>
    </div>
  `;
}

function render() {
  applyAppearance();
  const sidebarRows = flattenVisibleTree(state.tree);
  const selectedNode = getSelectedNode();

  app.innerHTML = `
    <div class="shell">
      <header class="topbar">
        <div class="brand-block">
          <p class="eyebrow">Private Tool</p>
          <h1>RandomPick</h1>
        </div>
        <div class="topbar-actions">
          <button class="button button-primary" data-action="add-root">Add Root List</button>
          <button class="button button-ghost" data-action="trigger-import">Import</button>
          <button class="button button-ghost" data-action="export-tree">Export</button>
          <button class="button button-ghost" data-action="save-now" ${state.saveStatus === "saving" ? "disabled" : ""}>Save Now</button>
          <label class="appearance-select">
            <span class="sr-only">Appearance</span>
            <select data-action="change-appearance">
              <option value="system" ${state.appearance === "system" ? "selected" : ""}>System</option>
              <option value="light" ${state.appearance === "light" ? "selected" : ""}>Light</option>
              <option value="dark" ${state.appearance === "dark" ? "selected" : ""}>Dark</option>
            </select>
          </label>
          <div class="save-pill" data-status="${state.saveStatus}">${saveStatusLabel()}</div>
        </div>
      </header>

      <main class="workspace">
        <aside class="sidebar-panel">
          <div class="panel-header">
            <div>
              <p class="panel-label">Tree</p>
              <h2>All Nodes</h2>
            </div>
            <p class="panel-meta">${state.tree.length} root ${state.tree.length === 1 ? "node" : "nodes"}</p>
          </div>
          ${renderConflictBanner()}
          ${
            state.errorMessage
              ? `<div class="banner banner-error"><p>${escapeHtml(state.errorMessage)}</p></div>`
              : ""
          }
          <div class="tree-list">
            ${renderSidebarRows(sidebarRows)}
            <div class="tree-end-drop ${state.drag.scope === "sidebar" && state.drag.targetId === "__root-end__" ? "is-drop-before" : ""}" data-role="sidebar-end-drop"></div>
          </div>
        </aside>

        <section class="detail-panel">
          ${renderDetailContent(selectedNode)}
        </section>
      </main>
      <input id="import-input" class="sr-only" type="file" accept="application/json" />
      ${renderImportDialog()}
      ${renderRandomResult()}
    </div>
  `;
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
  const targetId = targetRow.dataset.nodeId;
  const targetNode = findNode(state.tree, targetId);

  if (ratio < 0.28) {
    return "above";
  }

  if (ratio > 0.72) {
    return "below";
  }

  return targetNode?.kind === "list" ? "inside" : "below";
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
    case "add-root": {
      const root = createNode({ title: "New List", kind: "list" });
      commitTree(addRootNode(state.tree, root), root.id, 0);
      return;
    }
    case "add-child-list": {
      const child = createNode({ title: "New List", kind: "list" });
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
      queueSave(0);
      return;
    }
    case "select-node":
    case "open-node": {
      selectNode(nodeId);
      return;
    }
    case "pick-random": {
      const selectedNode = findNode(state.tree, nodeId);
      if (!selectedNode || selectedNode.kind !== "list" || selectedNode.children.length === 0) {
        return;
      }

      const pick = selectedNode.children[Math.floor(Math.random() * selectedNode.children.length)];
      if (pick.kind === "list") {
        state.selectedId = pick.id;
        state.randomResult = {
          message: `Picked "${pick.title}" and opened it.`,
        };
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
    case "save-now": {
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
      }
      flushSave();
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
    queueSave(300, false);
    return;
  }

  if (target.name === "composerTitle") {
    state.composerTitle = target.value;
  }
}

function handleChange(event) {
  const target = event.target;

  if (target.matches('[data-action="change-appearance"]')) {
    setAppearance(target.value);
    render();
    return;
  }

  if (target.matches('[data-action="edit-title"]')) {
    render();
    return;
  }

  if (target.name === "composerKind") {
    state.composerKind = target.value;
    render();
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

  if (!selectedNode || selectedNode.kind !== "list") {
    return;
  }

  const title = state.composerTitle.trim();
  if (!title) {
    return;
  }

  const nextNode = createNode({
    title,
    kind: state.composerKind,
  });

  commitTree(addChildNode(state.tree, selectedNode.id, nextNode), selectedNode.id, 0);
  state.composerTitle = "";
  state.composerKind = "item";
  renderAndFocusComposer();
}

function clearDragState() {
  state.drag = {
    nodeId: null,
    scope: null,
    targetId: null,
    position: null,
    targetIndex: null,
  };
  render();
}

function handleDragStart(event) {
  const sidebarRow = event.target.closest('[data-role="sidebar-row"]');
  if (sidebarRow) {
    state.drag = {
      nodeId: sidebarRow.dataset.nodeId,
      scope: "sidebar",
      targetId: null,
      position: null,
      targetIndex: null,
    };
    event.dataTransfer.effectAllowed = "move";
    render();
    return;
  }

  const detailRow = event.target.closest('[data-role="detail-row"]');
  if (detailRow) {
    state.drag = {
      nodeId: detailRow.dataset.nodeId,
      scope: "detail",
      targetId: null,
      position: null,
      targetIndex: Number(detailRow.dataset.index),
    };
    event.dataTransfer.effectAllowed = "move";
    render();
  }
}

function handleDragOver(event) {
  const sidebarRow = event.target.closest('[data-role="sidebar-row"]');
  if (sidebarRow && state.drag.scope === "sidebar") {
    event.preventDefault();
    state.drag.targetId = sidebarRow.dataset.nodeId;
    state.drag.position = computeSidebarDropPosition(sidebarRow, event.clientY);
    render();
    return;
  }

  const sidebarEnd = event.target.closest('[data-role="sidebar-end-drop"]');
  if (sidebarEnd && state.drag.scope === "sidebar") {
    event.preventDefault();
    state.drag.targetId = "__root-end__";
    state.drag.position = "end";
    render();
    return;
  }

  const detailRow = event.target.closest('[data-role="detail-row"]');
  if (detailRow && state.drag.scope === "detail") {
    event.preventDefault();
    state.drag.targetIndex = Number(detailRow.dataset.index);
    render();
    return;
  }

  const detailEnd = event.target.closest('[data-role="detail-end-drop"]');
  if (detailEnd && state.drag.scope === "detail") {
    event.preventDefault();
    state.drag.targetIndex = Number(detailEnd.dataset.index);
    render();
  }
}

function handleDrop(event) {
  const sidebarRow = event.target.closest('[data-role="sidebar-row"]');
  if (sidebarRow && state.drag.scope === "sidebar" && state.drag.nodeId) {
    event.preventDefault();
    const nextTree = moveNodeRelative(
      state.tree,
      state.drag.nodeId,
      sidebarRow.dataset.nodeId,
      computeSidebarDropPosition(sidebarRow, event.clientY),
    );
    commitTree(nextTree, state.selectedId, 0);
    clearDragState();
    return;
  }

  const sidebarEnd = event.target.closest('[data-role="sidebar-end-drop"]');
  if (sidebarEnd && state.drag.scope === "sidebar" && state.drag.nodeId) {
    event.preventDefault();
    commitTree(moveNodeToContainerEnd(state.tree, state.drag.nodeId, null), state.selectedId, 0);
    clearDragState();
    return;
  }

  const detailDropTarget = event.target.closest('[data-role="detail-row"], [data-role="detail-end-drop"]');
  const selectedNode = getSelectedNode();
  if (detailDropTarget && state.drag.scope === "detail" && state.drag.nodeId && selectedNode?.kind === "list") {
    event.preventDefault();
    const nextTree = moveNodeToParent(
      state.tree,
      state.drag.nodeId,
      selectedNode.id,
      Number(detailDropTarget.dataset.index),
    );
    commitTree(nextTree, selectedNode.id, 0);
    clearDragState();
  }
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
app.addEventListener("dragstart", handleDragStart);
app.addEventListener("dragover", handleDragOver);
app.addEventListener("drop", handleDrop);
app.addEventListener("dragend", clearDragState);

window.addEventListener("keydown", (event) => {
  if (event.defaultPrevented) {
    return;
  }

  const activeTag = document.activeElement?.tagName || "";
  const typing = ["INPUT", "TEXTAREA", "SELECT"].includes(activeTag);

  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
    event.preventDefault();
    flushSave();
    return;
  }

  if (typing) {
    return;
  }

  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "r") {
    event.preventDefault();
    const selectedNode = getSelectedNode();
    if (selectedNode?.kind === "list" && selectedNode.children.length > 0) {
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
  }
});

document.addEventListener("visibilitychange", () => {
  if (document.hidden && state.saveStatus === "dirty") {
    flushSave();
  }
});

systemThemeQuery.addEventListener("change", () => {
  if (state.appearance === "system") {
    applyAppearance();
  }
});

setAppearance(state.appearance);
render();
loadState();
