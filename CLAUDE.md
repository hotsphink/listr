# Listr

Trello-like list management app with customizable per-board attribute schemas.

## Structure

Monorepo with pnpm workspaces:
- `packages/shared` — TypeScript types, format string parser (no framework dependency)
- `packages/client` — SolidJS + Vite frontend, Dexie.js for IndexedDB
- `packages/server` — sync server (Node.js + WebSocket + SQLite)

## Dependencies / Tools
- pnpm is used instead of npm or npx.
- source code is managed with jj.

## Key design decisions

- SolidJS for fine-grained reactivity (no VDOM)
- Dexie.js wraps IndexedDB; reactive subscriptions via `createEffect` + `liveQuery`
- `title` is a first-class Item field, not part of the dynamic schema
- Attribute schema and default format string live on Board, not List
- Lists belong to Boards; a List can override the Board's format string
- Formats: the language in doc/FORMAT.md (`[key]`, `[key:variant/fallback]`, derived attributes, conditions, styles), implemented in packages/shared/src/format. Stored as `format: { version, text }` on Board and List
- View modes: list (default), table, card, board (per-list, persisted)
- Use `jj` for version control, not git
- PWA with service worker for offline support
- Sync: WebSocket LWW (document-level, updated_at wins). Server stores full entity snapshots + tombstones in SQLite. Client pushes local changes + pulls remote on connect; real-time broadcast thereafter. Sync key = shared secret namespace.

## Policies

- Do not use non-ASCII for code or comments. Non-ASCII is ok for standalone documents.
- Do not use em-dashes (or the ASCII equivalents). Split into multiple sentences or clauses linked by an appropriate conjunction instead.
- Comments should describe the current state, not changes made from previous states.
- Comments should be brief.
- Prefer the active voice and imperatives.

