# Listr

Trello-like list management app with customizable per-category attribute schemas.

## Structure

Monorepo with npm workspaces:
- `packages/shared` — TypeScript types, format string parser (no framework dependency)
- `packages/client` — SolidJS + Vite frontend, Dexie.js for IndexedDB
- `packages/server` — sync server (placeholder)

## Commands

- `npm run dev` — start Vite dev server on port 3000
- `npm run build` — production build
- `npm test` — run all workspace tests (vitest)
- `npm run test --workspace=@listr/shared` — run shared package tests only
- `npm run test:e2e` — run Playwright e2e tests (from root)
- Run Playwright from `packages/client` directory, not root

## Key design decisions

- SolidJS for fine-grained reactivity (no VDOM)
- Dexie.js wraps IndexedDB; reactive subscriptions via `createEffect` + `liveQuery`
- `title` is a first-class Item field, not part of the dynamic schema
- Attribute schema and default format string live on Category, not List
- Lists belong to Categories; a List can override the Category's format string
- Format strings: `{key}`, `{key:modifier}`, `{content|}` conditionals, `{key:?true:false}` ternary
- View modes: list (default), table, card, board (per-list, persisted)
- Use `jj` for version control, not git
- PWA with service worker for offline support
