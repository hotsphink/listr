# Listr — Architecture

## Overview

Listr is a Trello-like list management app. Items always have a title and live in Lists; Lists belong to Categories; Categories define the attribute schema shared by all their lists. Data is stored client-side in IndexedDB with a SolidJS frontend and an optional WebSocket sync server.

**Monorepo** (pnpm workspaces):
```
packages/
  shared/   — TypeScript types, format string parser (no framework deps)
  client/   — SolidJS + Vite frontend
  server/   — sync server (Node.js + WebSocket + SQLite)
certs/      — TLS certs (gitignored; generate with tailscale cert)
```

**Commands:**
```
pnpm dev             # Vite dev server at https://:3000
pnpm build           # production build
pnpm test            # vitest unit tests (all packages)
pnpm --filter @listr/shared test   # shared package tests only
cd packages/client && npx playwright test   # e2e tests (must run from packages/client)
cd packages/server && pnpm dev     # sync server at wss://:10000
jj commit -m "..."   # version control — uses jj, not git
```

**TLS / HTTPS:**
Both the Vite dev server and sync server use the same Tailscale-provisioned cert:
```
mkdir certs
tailscale cert --cert-file certs/tailscale.crt --key-file certs/tailscale.key finkripper.heron-moth.ts.net
```
Vite reads `../../certs/` relative to `packages/client/vite.config.ts`. The sync server reads `../../../certs/` relative to `packages/server/src/index.ts` (both resolve to repo root `certs/`).

---

## Data Model

```
Category 1──* List 1──* Item
Category owns: schema (AttributeDefinition[]), format_string, macros
List owns: format_string (string | null — null means inherit from Category), view_mode
Item owns: title (first-class field), attributes (Record<string, unknown>)
```

### Types (`packages/shared/src/types.ts`)

```typescript
type AttributeType = "text"|"number"|"date"|"datetime"|"boolean"|"enum"|"tags"|"url"|"duration";

interface AttributeDefinition {
  key: string;             // machine name, used in format strings
  label: string;           // display name
  type: AttributeType;
  required: boolean;
  default_value?: unknown;
  auto?: AutoBehavior;     // { trigger: "on_create"|..., source: "timestamp"|... }
  options?: string[];      // for enum/tags
  config?: Record<string, unknown>;
  position: number;
}

interface Category {
  id: string; name: string; color: string; position: number;
  schema: AttributeDefinition[];
  format_string: string;
  macros?: Record<string, string>;
  created_at: number; updated_at: number;
}

type ViewMode = "list" | "table" | "board" | "card";

interface List {
  id: string;
  category_id: string;     // required — no uncategorized lists
  name: string; icon: string; position: number;
  format_string: string | null;  // null = inherit from Category
  view_mode: ViewMode;           // per-list, NOT synced across devices
  created_at: number; updated_at: number;
}

interface Item {
  id: string; list_id: string;
  title: string;           // first-class field, not in schema
  position: number;
  created_at: number; updated_at: number;
  attributes: Record<string, unknown>;
}
```

---

## Database (`packages/client/src/db/`)

**Dexie.js** wraps IndexedDB. Schema versions:
- v1: original schema (lists had a `schema` field directly)
- v2: migration moves `schema` to categories; uncategorized lists assigned to a "General" category
- v3: adds `updated_at` index on all entity tables; adds `sync_config` and `tombstones` tables

**Sync tables (v3):**
```typescript
interface SyncConfig {
  id: string;          // always "default"
  sync_url: string;
  sync_key: string;
  client_id: string;   // random UUID, identifies this device
  enabled: boolean;
  last_sync_at: number;
}

interface LocalTombstone {
  id: string;          // "${entity_type}:${entity_id}"
  entity_type: string;
  entity_id: string;
  deleted_at: number;
}
```

**Reactive queries** — the correct SolidJS pattern:
```typescript
// CORRECT — re-subscribes when params.id changes
createEffect(() => {
  const id = params.id;
  const sub = liveQuery(() => db.lists.get(id)).subscribe((v) => setList(v));
  onCleanup(() => sub.unsubscribe());
});

// WRONG — from(liveQuery(...)) captures id at signal creation, doesn't re-subscribe on changes
const list = from(liveQuery(() => db.lists.get(params.id)));
```

**Schema lookup** — `operations.ts` has `getSchemaForList(listId)` which follows `list → category → schema`. Item creation uses this to apply `default_value` and `auto` behaviors. All write operations also call `syncClient.pushEntity(...)` or `syncClient.pushDelete(...)` after the DB write.

---

## Format String System (`packages/shared/src/format-string.ts`)

### Syntax

| Syntax | Meaning |
|--------|---------|
| `{title}` | Simple placeholder |
| `{key:modifier}` | With modifier |
| `{key:modifier=arg}` | Modifier with argument |
| `{ body \| fallback }` | Conditional: renders body if all inner placeholders have values, else fallback |
| `{key:?true text:false text}` | Ternary: branches can contain nested `{placeholders}` |
| `{{` / `}}` | Escaped braces |

HTML tags (`<b>`, `<i>`, `<em>`, etc.) are allowed in format string literals. Placeholder values are always HTML-escaped when using `renderFormatStringHtml`.

### Built-in modifiers
`upper`, `lower`, `fallback=X`, `stars` (★☆), `short` (dates/durations), `long` (dates/durations)

### Exports
- `renderFormatString(format, item, schema?, modifiers?, macros?)` — returns plain text; used by tests and TestRunner
- `renderFormatStringHtml(format, item, schema?, modifiers?, macros?)` — returns HTML with values escaped; used by UI display components

### Key behaviors
- **Top-level missing placeholders**: render as empty string (not a fallback to title)
- **Missing placeholders inside conditionals**: cause the conditional to use its fallback branch
- **Unset boolean attributes**: treated as `false` when schema is provided (schema-aware via `schemaMap`)
- **Duration default format**: "2 hours 28 minutes" (uses `attrType` from schema)
- **`stars` modifier**: works on any number; Rating type was removed — use Number + `:stars`
- **Macros**: named sub-format-strings defined in the category, referenced as `{macroName}` in other strings; cycle detection prevents infinite expansion

### Segment types (AST)
```typescript
type Segment =
  | { kind: "literal"; text: string }
  | { kind: "placeholder"; key: string; modifier?: string; modifierArg?: string }
  | { kind: "conditional"; body: Segment[]; fallback: Segment[] }
  | { kind: "ternary"; key: string; trueBranch: Segment[]; falseBranch: Segment[] };
```

---

## Frontend Components (`packages/client/src/`)

### App structure
```
App.tsx
  Router
    /        → Dashboard.tsx
    /list/:id → ListView.tsx
    /test     → TestRunner.tsx
  Sidebar.tsx (always visible)
```

`App.tsx` calls `syncClient.connect(...)` on mount if sync is configured and enabled.

### Sidebar (`components/Sidebar.tsx`)
- Accordion: `expandedCategoryId` signal, only one category open at a time
- Auto-expands to show the category containing the active list (via `createEffect` watching `location.pathname`)
- Footer shows a colored sync status dot; clicking opens `SyncSettingsModal`
- **Category "Configure"**: opens `CategoryFormModal` directly from Sidebar — does NOT navigate away

### Key Components
- `CategoryFormModal` — name, color picker, format string (auto-generates from schema unless manually edited), full SchemaEditor
- `ListFormModal` — name, required category dropdown, optional format string override (checkbox)
- `SchemaEditor` — uses `<Index>` (not `<For>`) for stable DOM; all buttons have `type="button"`; inputs use `onBlur` not `onInput`
- `AttributeEditor` — per-type inputs: number uses `onBlur`; duration has spinners + text field ("1h42m", "1h42", "42m", "42" all valid)
- `ItemFormModal` — loops over schema to render AttributeEditor per attribute
- `SyncSettingsModal` — configure sync URL, key, client ID; shows live status dot
- `FormattedText` — renders HTML from `renderFormatStringHtml`; uses `element.setHTML()` with Sanitizer if available, falls back to `innerHTML`
- `ContextMenu` — positioned `fixed`, closes on click outside or Escape
- `Modal` — base overlay, closes on Escape or overlay click

### ListView (`pages/ListView.tsx`)
- Gets schema from category via separate `createEffect` subscription
- `effectiveFormatString = list.format_string || category.format_string || "{title}"`
- Search input filters `allItems()` client-side into `items()`; mobile shows a toggle button that reveals a full-width search bar below the header
- Four view modes via `<Switch>/<Match>`; mode stored per-list in DB
- **Table view**: Title column shows raw `item.title`; other columns use `formatCellValue`
- **List/Card/Board views**: use `<FormattedText html={formatItem(item)} />` — supports HTML tags in format strings
- **Board view**: groups by first `enum` attribute in schema; shows one column per option + an "Unset" column
- Drag handles (`⠿`) on each item; `useSortable` initialized with a `ref` callback per view container

### Drag & Drop (`hooks/useSortable.ts`, `hooks/reorderLogic.ts`)
SortableJS with DOM-revert pattern for SolidJS compatibility:
```typescript
onEnd: async (evt) => {
  // 1. Revert the DOM move — SolidJS owns the DOM, not SortableJS
  container.insertBefore(item, ref);
  // 2. Compute new positions (pure function in reorderLogic.ts)
  const updates = computeReorder(currentItems, oldIndex, newIndex);
  // 3. Write to DB with updated_at timestamp
  await db.transaction("rw", db.items, async () => { /* update positions */ });
  // 4. Push to sync using pre-fetched item data
  for (const { id, position } of updates) syncClient.pushEntity("item", { ...base, position, updated_at: timestamp });
}
```
- `handle: ".drag-handle"` — only the grip icon initiates drag
- `filter` + `onMove` prevent dragging/dropping on the "+ Add Item" elements

### In-Browser Test Runner (`pages/TestRunner.tsx`)
Available at `/test`. Creates a fresh throwaway Dexie DB per run, deleted after.

---

## Sync (`packages/client/src/sync/`, `packages/server/`)

### Protocol
WebSocket over WSS. All messages are JSON.

**Handshake:**
```
client → { type: "hello", key: "<sync_key>", client_id: "<uuid>" }
server → { type: "ok" }
client → push all local entities/tombstones updated since last_sync_at
client → { type: "pull", since: <last_sync_at> }
server → { type: "snapshot", categories: [...], lists: [...], items: [...], tombstones: [...], server_time: <ms> }
```

**Ongoing (real-time):**
```
client → { type: "push_entity", entity_type: "item"|"list"|"category", data: {...} }
server → broadcasts { type: "entity", entity_type, data } to other clients in same room

client → { type: "push_delete", entity_type, entity_id, deleted_at }
server → broadcasts { type: "deleted", entity_type, entity_id, deleted_at }
```

### Conflict resolution: Last-Writer-Wins (document-level)
`updated_at` timestamp wins. An incoming entity is rejected if `incoming.updated_at <= existing.updated_at`.

**Special case — `view_mode`**: This field is intentionally per-device. `applyIncomingEntity` (in `mergeLogic.ts`) always preserves the local `view_mode` when merging an incoming list entity, regardless of timestamps.

### Client-side sync (`packages/client/src/sync/`)
- **`SyncClient.ts`** — singleton `syncClient`; manages WebSocket lifecycle with 5-second reconnect; exposes `connect`, `disconnect`, `pushEntity`, `pushDelete`
- **`syncStore.ts`** — module-level SolidJS signals (`syncStatus`, `syncStatusMessage`) readable from any component
- **`mergeLogic.ts`** — pure `applyIncomingEntity(entityType, incoming, existing)` function; testable without SolidJS/Dexie

### Server (`packages/server/src/`)
- **`index.ts`** — HTTPS server + WebSocket server on port 10000; rooms keyed by sync key
- **`db.ts`** — SQLite via `better-sqlite3`; `upsertEntity` (LWW), `getEntitiesSince`, `applyTombstone`, `getTombstonesSince`
- Data stored in `packages/server/data/listr.db` (gitignored)

---

## Testing

### Unit tests (Vitest)
```
pnpm test
pnpm --filter @listr/shared test
```
- `packages/shared/src/format-string.test.ts` — 37 tests covering parser and renderer
- `packages/client/src/sync/sync.test.ts` — merge logic (LWW, view_mode isolation)
- `packages/client/src/hooks/reorder.test.ts` — `computeReorder` pure function

### E2E tests (Playwright)
**Must run from `packages/client` directory:**
```bash
cd packages/client && npx playwright test
```

Uses Playwright's own Firefox build (system Firefox at `/usr/bin/firefox` lacks the required protocol). Config in `packages/client/playwright.config.ts`.

Test files:
- `e2e/helpers.ts` — `clearDatabase`, `fillSchemaField`, `createCategory`, `createListInCategory`
- `e2e/custom-attribute.spec.ts` — attribute creation and display
- `e2e/view-mode.spec.ts` — view switching, search, persistence
- `e2e/context-menu.spec.ts` — sidebar right-click menu

**Key Playwright patterns:**
- Use `click({clickCount: 3}) + keyboard.type()` for schema fields (not `fill()` — triggers SolidJS re-render mid-operation causing detached element errors)
- Scope button searches to `.modal` to avoid matching background elements
- Clear IndexedDB between tests with `indexedDB.deleteDatabase("listr")`

---

## PWA

- `packages/client/public/manifest.json` — installability metadata
- `packages/client/public/sw.js` — stale-while-revalidate service worker
- Registered in `index.html` via `navigator.serviceWorker.register("/sw.js")`

---

## Common Pitfalls

1. **`<For>` vs `<Index>`**: Use `<Index>` when DOM stability matters (e.g., focused inputs). `<For>` tracks by object reference — a new array (even with same content) recreates all DOM nodes.

2. **Buttons in forms**: Every `<button>` inside a `<form>` that isn't the submit button needs `type="button"`. The HTML default is `type="submit"`.

3. **Number inputs mid-typing**: Use `onBlur` not `onInput`. `valueAsNumber` is `NaN` while the user is typing "7." which causes unwanted state resets.

4. **Schema editor key input**: Uses `onBlur` — updating state on every keystroke caused `<Index>` to re-render and steal focus from the input.

5. **Livequery + route params**: `from(liveQuery(() => db.lists.get(params.id)))` only subscribes once at component creation. Use `createEffect` + manual subscription + `onCleanup` to re-subscribe when params change.

6. **Sidebar "Configure" for categories**: Opens `CategoryFormModal` directly from Sidebar state. Does NOT navigate to `/`. An earlier implementation navigated to Dashboard first, which briefly rendered the full dashboard view before the modal appeared.

7. **Vite HMR + new imports**: Adding a new `import` to an existing module changes the module graph in a way Vite HMR doesn't always handle cleanly. If behavior seems wrong after adding an import, do a full browser reload.

8. **Position sync**: Item reorder writes `updated_at: timestamp` alongside the new `position`, then pushes sync using the pre-fetched `currentItems` data overlaid with `{ position, updated_at: timestamp }` — avoids extra DB reads and ensures the timestamp is included.
