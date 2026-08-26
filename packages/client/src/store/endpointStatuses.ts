import { createSignal } from "solid-js";

// "needs_grant" (§4.2, §6): the handshake completed (signature verified) but
// this client isn't registered on this server yet. Waiting for a grant to be
// redeemed. Distinct from "error" because it isn't a failure to recover from by
// retrying. The join UI uses it to decide whether to show a join screen.
export type EndpointPhase = "disabled" | "connecting" | "handshaking" | "needs_grant" | "ready" | "error" | "conflict" | "variant_mismatch";

export interface EndpointStatus {
  phase: EndpointPhase;
  serverId?: string;
  knownId?: string;
  newId?: string;
  message?: string;
  /** Only set when phase is "variant_mismatch" — the server's declared world
   * (e.g. "dev"/"prod") vs. this client's build. */
  serverVariant?: string;
  clientVariant?: string;
  /** Only set on phase "error" when the server gave a structured reason (§4.2:
   * "suspended" | "revoked" | "bad_signature" | "protocol" | a grant redemption
   * failure reason). Lets SyncClient tell an account-state rejection apart from
   * a transient connection failure and persist it to server_identity (§8.1)
   * instead of just retrying blindly. */
  authReason?: string;
  /** Only meaningful when phase is "ready". False means another endpoint is
   * already connected to the same server_id and is handling push/pull. This
   * connection is a hot standby. */
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
