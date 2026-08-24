import { createSignal } from "solid-js";

export type BoardGroupKey = "own" | "shared";

const STORAGE_KEY = "sidebar-collapsed-groups";

function loadCollapsed(): Set<BoardGroupKey> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw) as string[];
    return new Set(arr.filter((k): k is BoardGroupKey => k === "own" || k === "shared"));
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
