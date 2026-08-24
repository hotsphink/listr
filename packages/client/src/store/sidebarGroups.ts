import { createSignal } from "solid-js";

// "own" and "shared" are the two fixed pseudo-groups (My Boards / the generic
// Shared Boards bucket); any other key is a real board group's sync_key.
export type BoardGroupKey = string;

const STORAGE_KEY = "sidebar-collapsed-groups";

function loadCollapsed(): Set<BoardGroupKey> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return new Set();
    return new Set(arr.filter((k): k is string => typeof k === "string"));
  } catch {
    return new Set();
  }
}

const [collapsedGroups, setCollapsedGroups] = createSignal<Set<BoardGroupKey>>(loadCollapsed());

export { collapsedGroups };

export function toggleGroupCollapsed(key: BoardGroupKey) {
  const next = new Set(collapsedGroups());
  next.has(key) ? next.delete(key) : next.add(key);
  setCollapsedGroups(next);
  localStorage.setItem(STORAGE_KEY, JSON.stringify([...next]));
}
