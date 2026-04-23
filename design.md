# RandomPick / WhatToDo Web App

## Implementation Note

The code currently implemented in this repo uses an even lighter stack than the original design recommendation:

- single Node service
- browser-side ES modules instead of a bundled React frontend
- SQLite via Node's built-in `node:sqlite`

The product scope, deploy shape, and interaction model in the rest of this document still apply.

## Overview

This project converts the native SwiftUI `WhatToDo` app into a private web app deployed at `random.ziyang.li` on the existing Hetzner VM.

The web version should preserve the current product's core value:

- nested lists and sublists for organizing choices
- fast item and list editing
- drag-and-drop reordering
- random selection from the current list
- JSON import/export compatibility with the existing Swift app

The web version should visually align with `fsrs` and `ecommercestore`:

- Apple-like typography and spacing
- soft glass/sticky header treatment
- rounded surfaces and restrained blue accent
- clean, desktop-first layout

Unlike those apps, this one should use a lighter stack and deployment model.

## Product Goals

- Recreate the current personal workflow in the browser with minimal friction.
- Keep the app fast and simple enough to run comfortably as a single-user tool.
- Support desktop usage first, with mobile access as a secondary but functional mode.
- Avoid overbuilding auth, database schema, and service boundaries.

## Non-Goals

- Multi-user accounts
- collaboration
- public sharing
- payments
- notifications
- complex analytics
- a large normalized backend API surface

## Current App Scope

The Swift app currently provides:

- recursive tree of `TodoNode`
- CRUD for lists and items
- drag-and-drop in the sidebar for reorder and nesting
- drag-and-drop reorder within the current list
- random pick from the selected list
- appearance setting
- JSON export/import

Important existing quirks worth fixing in the web version:

- selection can become invalid after deletes
- add behavior depends too much on current selection
- drag state can get visually stuck

## Recommended Stack

- Frontend: TypeScript, React, Vite
- State management: React context + reducer
- Drag and drop: `dnd-kit`
- Backend: Go with `chi`
- Persistence: SQLite via a pure-Go driver
- Deployment: single Docker container on the shared VM
- Edge routing: existing `fsrs` nginx edge using the shared Docker network
- Access control: nginx basic auth at the edge

## Why This Stack

This keeps consistency with the existing repos without inheriting their weight.

- React/Vite matches the frontend style and tooling already used in `fsrs` and `ecommercestore`.
- Go keeps backend deployment simple and familiar.
- SQLite is sufficient because this is a private single-user tool with small data volume.
- A single container is enough because the app does not need a separate frontend service, internal nginx, or Postgres.
- Edge basic auth is simpler than building login, cookies, password reset, and user tables for a personal tool.

## High-Level Architecture

The app should be split in source code, but deployed as one runtime service.

```text
randompick/
├── frontend/
│   ├── src/
│   │   ├── components/
│   │   ├── features/tree/
│   │   ├── features/detail/
│   │   ├── features/import-export/
│   │   ├── lib/
│   │   ├── styles/
│   │   ├── App.tsx
│   │   └── main.tsx
│   ├── package.json
│   └── vite.config.ts
├── backend/
│   ├── cmd/server/main.go
│   ├── internal/api/
│   ├── internal/model/
│   ├── internal/store/
│   └── go.mod
├── Dockerfile
├── docker-compose.prod.yml
├── scripts/deploy-randompick.sh
└── design.md
```

Deployment model:

- Vite builds static frontend assets.
- Go serves the API and the compiled frontend assets.
- SQLite database file is stored on a mounted Docker volume.
- The container joins the existing `shared-edge` Docker network.
- The existing public nginx edge routes `random.ziyang.li` to this app.

## Persistence Model

Use a whole-document persistence model rather than a normalized relational tree schema.

Store the entire tree as one JSON document in SQLite, plus version metadata.

Suggested table:

```sql
CREATE TABLE app_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    version INTEGER NOT NULL,
    tree_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
```

Optional backup table:

```sql
CREATE TABLE app_backups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,
    tree_json TEXT NOT NULL,
    created_at TEXT NOT NULL
);
```

## Why Whole-Document Persistence

- The current app already thinks in terms of one in-memory tree.
- Import/export is naturally whole-document JSON.
- The data set is small.
- This greatly reduces backend complexity.
- It avoids a large CRUD API for individual nodes.

Tradeoff:

- concurrent edits from multiple browsers become last-write-wins unless guarded

Mitigation:

- include a `version` field in responses
- require clients to send the last known version on save
- return `409 Conflict` if the document changed underneath the client

That is enough for a personal tool.

## Internal Frontend Data Model

Use an explicit internal node shape instead of overloading `children == nil`.

```ts
type NodeKind = "list" | "item";

type TreeNode = {
  id: string;
  title: string;
  kind: NodeKind;
  isExpanded: boolean;
  children: TreeNode[];
};
```

Rules:

- `list` nodes may contain children
- `item` nodes never contain children
- imported Swift JSON is migrated into this structure on load/import
- exported JSON should remain compatible with the current Swift app shape

## Import / Export Compatibility

The web app must support the existing Swift JSON export format directly.

Import mapping:

- if `children` is missing or `null`, treat the node as an `item`
- if `children` is an array, treat the node as a `list`
- preserve `id`, `title`, and `isExpanded` where possible

Export mapping:

- export `list` nodes with `children`
- export `item` nodes without `children`
- preserve IDs to allow round-tripping between native and web versions

This keeps the migration path clean and gives you an immediate bootstrap data source.

## Frontend UX Design

The web UI should be a desktop-first full-height app shell, not a multi-page marketing site.

### Layout

- sticky frosted top bar
- left sidebar for the recursive tree
- right detail pane for the selected list
- mobile layout switches the sidebar into a sheet or drawer

### Top Bar

- app title
- add root list
- import
- export
- theme toggle or appearance menu
- optional manual save indicator

### Sidebar

- recursive tree view
- expand/collapse controls
- selection highlight
- context actions: add child, rename, delete
- drag-and-drop reorder and nesting

### Detail Pane

- selected list title
- item count
- random pick button
- editable child items
- reorder child items by drag-and-drop
- add-item composer fixed to the bottom of the pane

### Empty States

- no data: invite import or create first list
- no selection: select a list or create one
- empty list: show add-item affordance clearly

## Visual Direction

Borrow the visual language from `fsrs` and `ecommercestore`, but adapt it to a tool-style application.

- system/SF font stack
- white and very light gray surfaces
- subtle translucent header
- blue accent for focus, actions, and drop indicators
- rounded rows and soft shadow cards
- generous whitespace

The app should feel closer to a native productivity tool than a generic SaaS dashboard.

## Drag-and-Drop Requirements

Drag-and-drop reorder is a required v1 feature.

### Sidebar Tree DnD

Required operations:

- reorder root lists
- reorder siblings within the same parent
- move a node into another list
- move a nested node back to root
- prevent dropping onto self or descendants

Recommended implementation:

- use `dnd-kit`
- represent the visible tree as a flattened list during drag
- compute drop target and intent:
  - above target
  - inside target
  - below target
- show clear drop indicators

Behavior notes:

- only `list` nodes can accept `inside` drops
- `item` nodes only support above/below reorder
- dropping onto a collapsed list can still nest inside it
- after nesting into a list, that list should auto-expand

### Detail Pane DnD

Required operations:

- reorder items and sublists within the selected list

Recommended behavior:

- drag handle shown on row hover or always visible on desktop
- keyboard and touch fallback actions remain available for non-pointer usage

### Mobile Fallback

Desktop is the primary target. On mobile:

- keep simple drag reorder where practical
- provide explicit move actions if tree drag becomes too awkward

## State Management

Use a centralized app store on the frontend.

Suggested responsibilities:

- current tree document
- selected node ID
- save status
- pending import/export state
- conflict handling

Update model:

- optimistic local updates first
- debounce routine edits
- flush immediately after drag end, import, delete, and structural changes

## Save Strategy

- load the full document on app boot
- save the full document via API after mutations
- autosave after a short debounce for text edits
- save immediately on blur, drag end, import, delete, or before unload when possible

Suggested UX:

- show `Saved`, `Saving...`, or `Save conflict`
- keep errors non-blocking but visible

## Selection Rules

The web version should remove current selection fragility.

Rules:

- if the selected node is deleted, select:
  - next sibling if available
  - otherwise previous sibling
  - otherwise parent
  - otherwise first root
  - otherwise no selection
- adding a root list should select it
- adding a child should keep the current list selected unless the user explicitly navigates into the child
- the UI must support no selection safely

## API Surface

Keep the backend API intentionally small.

```http
GET    /api/healthz
GET    /api/state
PUT    /api/state
POST   /api/import?mode=replace
POST   /api/import?mode=merge
GET    /api/export
```

### GET /api/state

Response:

```json
{
  "version": 12,
  "tree": []
}
```

### PUT /api/state

Request:

```json
{
  "version": 12,
  "tree": []
}
```

Responses:

- `200 OK` with updated version
- `409 Conflict` if the server version is newer

### POST /api/import

- accepts uploaded JSON
- supports `replace` and `merge`
- validates structure before writing
- creates a backup before destructive replace

### GET /api/export

- returns Swift-compatible JSON document

## Backend Responsibilities

- serve static frontend assets
- load and save document state
- validate imported JSON
- manage version checks for optimistic concurrency
- create backups before destructive imports
- expose health check

The backend should not own application behavior like random picking or tree editing logic unless needed for validation. Most editing logic belongs in the frontend store.

## Security Model

This is a private personal tool, so keep security proportional.

Recommended approach:

- terminate TLS at the existing public nginx edge
- add nginx basic auth for `random.ziyang.li`
- keep the app private behind that gate
- no in-app user table
- no JWT/session flow

Benefits:

- much smaller implementation
- less password-reset and auth surface area
- fits the actual usage model

If later needed, app-level auth can be added without throwing away the frontend.

## Deployment Design

Run this app on the same VM as `fsrs` and `store`.

### DNS

- add `A` record: `random.ziyang.li` -> `5.78.201.47`

### Edge Routing

Update the existing shared edge nginx config on the VM:

- add upstream for the new app on the `shared-edge` network
- add HTTP to HTTPS redirect for `random.ziyang.li`
- add HTTPS server block for `random.ziyang.li`
- add `auth_basic`
- proxy all traffic to the app container

### Runtime Stack

Use one compose service:

- `app`: Go server serving API plus static frontend

Optional second service only if needed later:

- none

Volume:

- `randompick-data` for the SQLite database file

Network:

- external Docker network `shared-edge`

## Suggested Production Compose Shape

```yaml
services:
  app:
    image: randompick:latest
    volumes:
      - randompick-data:/data
    environment:
      PORT: 8080
      DATABASE_PATH: /data/randompick.db
      APP_BASE_URL: https://random.ziyang.li
    networks:
      default: {}
      edge:
        aliases:
          - randompick-edge
    restart: unless-stopped

networks:
  edge:
    name: shared-edge
    external: true

volumes:
  randompick-data:
```

## Backup Strategy

Because the app is personal and the data is small, keep backups simple.

Primary protections:

- manual JSON export from the UI
- automatic backup row before destructive import replace
- periodic VM-level backup of the SQLite volume

Nice-to-have:

- nightly export to a timestamped JSON file on the host

## Performance Expectations

The expected data size is tiny. Performance constraints are mostly UI interaction, not database load.

Priorities:

- instant local drag feedback
- fast tree rendering for a few hundred nodes
- low-latency save flow
- no unnecessary backend round trips during editing

If rendering becomes noisy with larger trees:

- flatten visible tree for rendering
- memoize row boundaries only where profiling proves it useful

## Testing Strategy

### Frontend

- reducer/store tests for tree mutations
- drag intent calculation tests
- import/export mapping tests
- selection fallback tests after delete/move
- component tests for sidebar and detail interactions

### Backend

- state load/save tests
- import validation tests
- conflict/version tests
- export compatibility tests

### Manual Verification

- import existing Swift export
- drag reorder roots, siblings, and nested nodes
- reorder children in the detail pane
- random pick on list with items and sublists
- delete selected node and verify fallback selection
- export and verify JSON round-trip

## Implementation Phases

### Phase 1: Foundation

- scaffold frontend and backend
- establish styling tokens and shell layout
- implement state document load/save
- implement import/export compatibility

### Phase 2: Core Editing

- sidebar tree rendering
- selection model
- add, rename, delete
- detail pane item editing
- random pick

### Phase 3: Drag and Drop

- detail pane reorder
- sidebar reorder and nesting
- drop indicators and invalid-drop guards
- autosave integration after drag end

### Phase 4: Deployment

- Dockerfile
- production compose
- edge nginx route
- TLS and basic auth
- deploy script

### Phase 5: Polish

- mobile adjustments
- theme persistence
- keyboard shortcuts
- backup UX
- search if still wanted

## Open Questions

- Should the initial web version support only one root document, or named documents later?
- Should random picking enter sublists automatically when a picked child is itself a list, matching the Swift app?
- Should theme preference live only in browser storage, or also in server state for cross-device consistency?

## Final Recommendation

Build this as a small, single-user web app with:

- React/Vite frontend
- Go backend
- SQLite whole-document persistence
- `dnd-kit` for reorder and nesting
- one Docker container
- nginx basic auth at the shared edge

This preserves the current product well, matches the style of the existing web apps, and keeps the operational footprint appropriately small for `random.ziyang.li`.
