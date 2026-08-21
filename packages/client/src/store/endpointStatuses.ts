import { createSignal } from "solid-js";

export type EndpointPhase = "disabled" | "connecting" | "handshaking" | "ready" | "error" | "conflict";

export interface EndpointStatus {
  phase: EndpointPhase;
  serverId?: string;
  knownId?: string;
  newId?: string;
  message?: string;
  /** Only meaningful when phase is "ready". False means another endpoint is
   * already connected to the same server_id and is handling push/pull —
   * this connection is a hot standby, not actively used. */
  primary?: boolean;
}

export const [endpointStatuses, setEndpointStatuses] = createSignal<Record<string, EndpointStatus>>({});

export function setEndpointStatus(id: string, status: EndpointStatus): void {
  setEndpointStatuses((prev) => ({ ...prev, [id]: status }));
}

export function removeEndpointStatus(id: string): void {
  setEndpointStatuses((prev) => {
    const next = { ...prev };
    delete next[id];
    return next;
  });
}
