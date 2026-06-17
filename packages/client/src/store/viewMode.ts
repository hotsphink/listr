import { createSignal } from "solid-js";
export type AppViewMode = "list" | "table" | "card";
export const [appViewMode, setAppViewMode] = createSignal<AppViewMode>("list");
