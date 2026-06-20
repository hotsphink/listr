# Listr

Trello-like list management app with customizable per-board attribute schemas.

## Structure

Monorepo with pnpm workspaces:
- `packages/shared` — TypeScript types, format string parser (no framework dependency)
- `packages/client` — SolidJS + Vite frontend, Dexie.js for IndexedDB
- `packages/server` — sync server (Node.js + WebSocket + SQLite)

## Commands

- `pnpm dev` — start Vite dev server on port 3000
- `pnpm build` — production build
- `pnpm test` — run all workspace tests (vitest)
- `pnpm --filter @listr/shared test` — run shared package tests only
- `pnpm test:e2e` — run Playwright e2e tests (from root)
- Run Playwright from `packages/client` directory, not root
- Sync server: `cd packages/server && pnpm install && pnpm dev` — listens on port 10000 (all interfaces)

## Key design decisions

- SolidJS for fine-grained reactivity (no VDOM)
- Dexie.js wraps IndexedDB; reactive subscriptions via `createEffect` + `liveQuery`
- `title` is a first-class Item field, not part of the dynamic schema
- Attribute schema and default format string live on Board, not List
- Lists belong to Boards; a List can override the Board's format string
- Format strings: `{key}`, `{key:modifier}`, `{content|}` conditionals, `{key:?true:false}` ternary
- View modes: list (default), table, card, board (per-list, persisted)
- Use `jj` for version control, not git
- PWA with service worker for offline support
- Sync: WebSocket LWW (document-level, updated_at wins). Server stores full entity snapshots + tombstones in SQLite. Client pushes local changes + pulls remote on connect; real-time broadcast thereafter. Sync key = shared secret namespace.
