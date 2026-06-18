import { createSignal } from "solid-js";

export type EndpointPhase = "disabled" | "connecting" | "handshaking" | "ready" | "error" | "conflict";

export interface EndpointStatus {
  phase: EndpointPhase;
  serverId?: string;
  knownId?: string;
  newId?: string;
  message?: string;
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
