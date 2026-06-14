# Listr

Trello-like list management app with customizable per-list attribute schemas.

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

## Key design decisions

- SolidJS for fine-grained reactivity (no VDOM)
- Dexie.js wraps IndexedDB; `liveQuery` + SolidJS `from()` for reactive data
- `title` is a first-class Item field, not part of the dynamic schema
- Format strings use `{key}`, `{key:modifier}`, `{content|}` conditional syntax
- Attribute schema is embedded on the List entity (not a separate table)
