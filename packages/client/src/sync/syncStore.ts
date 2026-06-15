import { createSignal } from "solid-js";

export type SyncStatus = "disconnected" | "connecting" | "connected" | "error";
export const [syncStatus, setSyncStatus] = createSignal<SyncStatus>("disconnected");
export const [syncStatusMessage, setSyncStatusMessage] = createSignal("");
