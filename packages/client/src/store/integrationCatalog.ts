import { createMemo, createSignal } from "solid-js";
import type { IntegrationInfo } from "@listr/shared";

// Integration modules each connected server advertised in its `ok`, keyed by server id.
const [byServer, setByServer] = createSignal<Map<string, IntegrationInfo[]>>(new Map());

export function setServerIntegrations(serverId: string, integrations: IntegrationInfo[]): void {
  setByServer((prev) => new Map(prev).set(serverId, integrations));
}

/** Every advertised module, one per id. An active entry wins over an inactive one. */
export const availableIntegrations = createMemo((): IntegrationInfo[] => {
  const merged = new Map<string, IntegrationInfo>();
  for (const list of byServer().values()) {
    for (const info of list) {
      const prev = merged.get(info.id);
      if (!prev || (!prev.active && info.active)) merged.set(info.id, info);
    }
  }
  return [...merged.values()];
});
