import { createSignal } from "solid-js";

export const [selectedListIds, setSelectedListIds] = createSignal<Set<string>>(new Set());
