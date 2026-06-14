# Listr — Architecture

## Overview

Listr is a Trello-like list management app. Items always have a title and live in Lists; Lists belong to Categories; Categories define the attribute schema shared by all their lists. Data is stored client-side in IndexedDB with a SolidJS frontend.

**Monorepo** (npm workspaces):
```
packages/
  shared/   — TypeScript types, format string parser (no framework deps)
  client/   — SolidJS + Vite frontend
  server/   — sync server (placeholder, not yet implemented)
```

**Commands:**
```
npm run dev          # Vite dev server at :3000
npm run build        # production build
npm test             # vitest unit tests (packages/shared)
cd packages/client && npx playwright test   # e2e tests (must run from packages/client)
jj commit -m "..."   # version control — uses jj, not git
```

---

## Data Model

```
Category 1──* List 1──* Item
Category owns: schema (AttributeDefinition[]), format_string
List owns: format_string (string | null — null means inherit from Category)
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
  created_at: number; updated_at: number;
}

type ViewMode = "list" | "table" | "board" | "card";

interface List {
  id: string;
  category_id: string;     // required — no uncategorized lists
  name: string; icon: string; position: number;
  format_string: string | null;  // null = inherit from Category
  view_mode: ViewMode;
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

**Dexie.js** wraps IndexedDB. Two schema versions:
- v1: original schema (lists had a `schema` field directly)
- v2: migration moves `schema` to categories; uncategorized lists assigned to a "General" category; `schema` deleted from list records

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

**Schema lookup** — `operations.ts` has `getSchemaForList(listId)` which follows `list → category → schema`. Item creation uses this to apply `default_value` and `auto` behaviors.

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

### Built-in modifiers
`upper`, `lower`, `fallback=X`, `stars` (★☆), `short` (dates/durations), `long` (dates/durations)

### Key behaviors
- **Top-level missing placeholders**: render as empty string (not a fallback to title)
- **Missing placeholders inside conditionals**: cause the conditional to use its fallback branch
- **Unset boolean attributes**: treated as `false` when schema is provided (schema-aware via `schemaMap`)
- **Duration default format**: "2 hours 28 minutes" (uses `attrType` from schema)
- **`stars` modifier**: works on any number; Rating type was removed — use Number + `:stars`

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

### Sidebar (`components/Sidebar.tsx`)
- Accordion: `expandedCategoryId` signal, only one category open at a time
- Auto-expands to show the category containing the active list (via `createEffect` watching `location.pathname`)
- Clicking a category header toggles open/closed
- Expanded: shows nested lists + inline "+ New List" at bottom
- "+ New Category" at very bottom of all categories
- Right-click context menu on both categories and lists
- **Category "Configure"**: opens `CategoryFormModal` directly from Sidebar — does NOT navigate away. The Sidebar owns the modal state.
- Category "Rename": inline rename with `sidebar-rename-input`

### Key Components
- `CategoryFormModal` — name, color picker, format string (auto-generates from schema unless manually edited), full SchemaEditor
- `ListFormModal` — name, required category dropdown, optional format string override (checkbox)
- `SchemaEditor` — uses `<Index>` (not `<For>`) for stable DOM; all buttons have `type="button"`; inputs use `onBlur` not `onInput`
- `AttributeEditor` — per-type inputs: number uses `onBlur`; duration has spinners + text field ("1h42m", "1h42", "42m", "42" all valid)
- `ItemFormModal` — loops over schema to render AttributeEditor per attribute
- `ContextMenu` — positioned `fixed`, closes on click outside or Escape
- `Modal` — base overlay, closes on Escape or overlay click

### ListView (`pages/ListView.tsx`)
- Gets schema from category via separate `createEffect` subscription (not `from(liveQuery(...))`)
- `effectiveFormatString = list.format_string || category.format_string || "{title}"`
- Search input filters `allItems()` client-side into `items()`
- Four view modes via `<Switch>/<Match>`
- **Board view**: groups by first `enum` attribute in schema; shows one column per option + an "Unset" column
- **No "+ Add Item" in header** — add button lives at the bottom of each view
- Drag handles (`⠿`) on each item; `useSortable` initialized with a `ref` callback per view container

### Drag & Drop (`hooks/useSortable.ts`)
SortableJS with DOM-revert pattern for SolidJS compatibility:
```typescript
onEnd: async (evt) => {
  // 1. Revert the DOM move — SolidJS owns the DOM, not SortableJS
  container.insertBefore(item, ref);
  // 2. Update data — reactive re-render drives actual order
  await db.transaction("rw", db.items, async () => { /* update positions */ });
}
```
- `handle: ".drag-handle"` — only the grip icon initiates drag
- `filter` + `onMove` prevent dragging/dropping on the "+ Add Item" elements

### In-Browser Test Runner (`pages/TestRunner.tsx`)
Available at `/test`. Creates a fresh throwaway Dexie DB per run, deleted after. Uses `createTestCategory` / `createTestList` / `createTestItem` helpers mirroring the real operations pattern. Currently 8 tests.

---

## Testing

### Unit tests (Vitest)
```
npm run test --workspace=@listr/shared
```
Tests in `packages/shared/src/format-string.test.ts` covering parser and renderer.

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
