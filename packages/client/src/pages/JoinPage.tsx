import { type Component, createMemo, createSignal, createEffect, onCleanup, Show } from "solid-js";
import { useParams, useNavigate } from "@solidjs/router";
import { db } from "../db/database.js";
import { syncClient } from "../sync/SyncClient.js";
import { parseJoinPath, hashServerId, type JoinLinkPayload } from "../sync/joinLink.js";
import { DEFAULT_ENDPOINT } from "../sync/defaultEndpoint.js";
import { endpointStatuses } from "../store/endpointStatuses.js";
import type { EndpointStatus } from "../store/endpointStatuses.js";
import { countUnboundLocalBoards, discardUnboundLocalBoards } from "../db/operations.js";
import { setSidebarOpen } from "../store/sidebarStore.js";

type Step =
  | "invalid"
  | "resolving" // hashing configured endpoints / probing the default, looking for a server_id match
  | "unknown_server" // nothing matched, so offer to add a host by hand
  | "connecting" // matched an endpoint, waiting for the handshake to settle
  | "peeking" // connected, waiting for grant_info
  | "confirm" // grant_info in hand, showing the accept/keep-or-discard screen
  | "joining" // redeem_grant sent, waiting for ok or an error
  | "success"
  | "error";

interface GrantInfo {
  kind: string;
  greeting: string | null;
  issuerDisplayName: string | null;
}

const REASON_MESSAGES: Record<string, string> = {
  already_registered: "You already have an account on this server — ask for a share link instead.",
  used: "This link has already been used.",
  expired: "This link has expired.",
  burned: "Too many attempts were made with this link; it's no longer valid.",
  not_found: "This link doesn't match any invite on this server.",
  bad_secret: "This link looks corrupted.",
};

function reasonMessage(reason: string | undefined, fallback: string): string {
  return (reason && REASON_MESSAGES[reason]) || fallback;
}

const JoinPage: Component = () => {
  const params = useParams<{ hash: string; credentials: string }>();
  const navigate = useNavigate();

  const payload = createMemo<JoinLinkPayload | null>(() => parseJoinPath(params.hash, params.credentials));

  const [step, setStep] = createSignal<Step>("resolving");
  const [endpointId, setEndpointId] = createSignal<string | null>(null);
  const [manualHost, setManualHost] = createSignal("");
  const [manualPort, setManualPort] = createSignal(443);
  const [errorMessage, setErrorMessage] = createSignal<string | null>(null);
  const [grantInfo, setGrantInfo] = createSignal<GrantInfo | null>(null);
  const [unboundBoards, setUnboundBoards] = createSignal(0);
  const [keepChoice, setKeepChoice] = createSignal<"keep" | "discard" | null>(null);
  // Endpoints created speculatively while probing, whether the default or a
  // manual-host guess, that turned out NOT to match the link. Clean them up so
  // a failed guess does not linger as a dead row in AdminPage's endpoint
  // list.
  const speculativeEndpointIds = new Set<string>();

  const status = () => (endpointId() ? (endpointStatuses()[endpointId()!] as EndpointStatus | undefined) : undefined);

  async function cleanupSpeculative(exceptId?: string): Promise<void> {
    for (const id of [...speculativeEndpointIds]) {
      if (id === exceptId) continue;
      await db.sync_endpoints.delete(id).catch(() => {});
      speculativeEndpointIds.delete(id);
    }
  }

  // Resolve identity to route. Try every configured endpoint whose known
  // server_id hashes to the link's hash first, since that means "use my own
  // route to a server I already know", which is the whole reason the link
  // carries no route at all. Fall back to the baked-in default only when
  // nothing matches.
  async function tryConfiguredEndpoints(p: JoinLinkPayload): Promise<string | null> {
    const rows = await db.sync_endpoints.toArray();
    for (const row of rows) {
      if (!row.last_server_id) continue;
      const hash = await hashServerId(row.last_server_id);
      if (hash === p.serverHash) {
        if (!row.enabled) await db.sync_endpoints.update(row.id, { enabled: true });
        return row.id;
      }
    }
    return null;
  }

  async function probeEndpoint(host: string, port: number, secure: boolean): Promise<string> {
    // Reuse an existing row for the same route if one exists, rather than
    // piling up duplicates on repeated attempts. host/port aren't indexed,
    // so this is a plain in-memory scan rather than a Dexie where() query.
    const existing = (await db.sync_endpoints.toArray()).find((e) => e.host === host && e.port === port);
    if (existing) {
      if (!existing.enabled) await db.sync_endpoints.update(existing.id, { enabled: true });
      return existing.id;
    }
    const id = crypto.randomUUID();
    await db.sync_endpoints.add({ id, host, port, secure, enabled: true, last_server_id: null, position: Date.now() });
    speculativeEndpointIds.add(id);
    return id;
  }

  createEffect(() => {
    const p = payload();
    if (!p) { setStep("invalid"); return; }

    let cancelled = false;
    (async () => {
      setStep("resolving");
      const configured = await tryConfiguredEndpoints(p);
      if (cancelled) return;
      if (configured) {
        setEndpointId(configured);
        setStep("connecting");
        return;
      }
      const id = await probeEndpoint(DEFAULT_ENDPOINT.host, DEFAULT_ENDPOINT.port, DEFAULT_ENDPOINT.secure);
      if (cancelled) return;
      setEndpointId(id);
      setStep("connecting");
    })();

    onCleanup(() => { cancelled = true; });
  });

  // Once the resolved endpoint's handshake settles, confirm its server_id
  // matches the link's hash before doing anything else with it. That is what
  // makes "hash matches nothing -> say so" work for the default and
  // manual-host probe paths. A configured-endpoint match is already verified
  // before step becomes "connecting", so it always passes here too.
  createEffect(() => {
    const p = payload();
    const epId = endpointId();
    if (!p || !epId || step() !== "connecting") return;
    const s = status();
    if (!s) return;

    if (s.phase === "variant_mismatch") {
      setErrorMessage(s.message ?? "This server is a different build variant.");
      setStep("unknown_server");
      cleanupSpeculative();
      return;
    }
    if (s.phase === "conflict") {
      setErrorMessage("This host's server identity changed since it was last used — resolve that in Admin first.");
      setStep("unknown_server");
      cleanupSpeculative();
      return;
    }
    if (s.phase === "error" && !s.serverId) {
      setErrorMessage(s.message ?? "Couldn't reach that server.");
      setStep("unknown_server");
      cleanupSpeculative();
      return;
    }
    if (s.serverId) {
      hashServerId(s.serverId).then((hash) => {
        if (hash !== p.serverHash) {
          setErrorMessage("This link is for a server you don't have configured.");
          setStep("unknown_server");
          cleanupSpeculative();
          return;
        }
        // Confirmed: this speculative endpoint, if any, is the real one, so stop tracking it for cleanup.
        speculativeEndpointIds.delete(epId);
        if (s.phase === "needs_grant" || s.phase === "ready") {
          setStep("peeking");
          countUnboundLocalBoards().then(setUnboundBoards);
        }
      });
    }
  });

  // Ask for the grant's details, once per connection. The server answers on
  // the socket that asked, so a reconnect while the reply is in flight loses
  // it; this runs again whenever the connection comes back up, which is the
  // recovery. peek_grant consumes no use of the grant, so asking again costs
  // nothing.
  createEffect(() => {
    const p = payload();
    const epId = endpointId();
    const s = status();
    if (!p || !epId || !s || step() !== "peeking") return;
    if (s.phase !== "needs_grant" && s.phase !== "ready") return;
    try {
      syncClient.peekGrant(epId, p.grantId, p.secret);
    } catch {
      // The connection went away between the status update and this call. The
      // next one brings this effect back around.
    }
  });

  // Receive the peek_grant / redeem_grant reply on the resolved connection.
  createEffect(() => {
    const epId = endpointId();
    if (!epId) return;
    const unsubscribe = syncClient.onGrantReply(epId, (msg) => {
      if (msg.type === "grant_info") {
        setGrantInfo({ kind: msg.kind, greeting: msg.greeting ?? null, issuerDisplayName: msg.issuer_display_name ?? null });
        setStep("confirm");
      } else if (msg.type === "error") {
        setErrorMessage(reasonMessage(msg.reason, msg.message ?? "That didn't work."));
        setStep("error");
      }
    });
    onCleanup(unsubscribe);
  });

  // Success: the endpoint reaching "ready" after the join request means the
  // ok reply landed, which is redeem_grant's success path. See
  // SyncClient.onReady.
  createEffect(() => {
    if (step() !== "joining") return;
    const s = status();
    if (s?.phase === "ready") setStep("success");
  });

  const doJoin = async () => {
    const p = payload();
    const epId = endpointId();
    if (!p || !epId) return;
    if (unboundBoards() > 0 && keepChoice() === "discard") {
      await discardUnboundLocalBoards();
    }
    setStep("joining");
    try {
      syncClient.redeemGrant(epId, p.grantId, p.secret);
    } catch {
      setErrorMessage("Lost the connection to that server before joining. Open the link again.");
      setStep("error");
    }
  };

  const tryManualHost = async () => {
    const host = manualHost().trim();
    if (!host) return;
    await cleanupSpeculative();
    const secure = !/^(localhost|127\.0\.0\.1)$/i.test(host);
    const id = await probeEndpoint(host, manualPort() || 443, secure);
    setEndpointId(id);
    setErrorMessage(null);
    setStep("connecting");
  };

  const goHome = () => {
    setSidebarOpen(true);
    navigate("/");
  };

  return (
    <div class="main receive-page">
      <div class="panel receive-card">
        <Show when={step() === "invalid"}>
          <h2>Invalid join link</h2>
          <p class="field-hint">This link doesn't look like a valid Listr join link.</p>
          <button class="btn-primary" type="button" onClick={goHome}>Go home</button>
        </Show>

        <Show when={step() === "resolving" || step() === "connecting"}>
          <div class="receive-syncing">
            <div class="spinner" />
            <div>Connecting…</div>
          </div>
        </Show>

        <Show when={step() === "peeking"}>
          <div class="receive-syncing">
            <div class="spinner" />
            <div>Looking up your invite…</div>
          </div>
        </Show>

        <Show when={step() === "unknown_server"}>
          <h2>Server not found</h2>
          <p class="field-hint">{errorMessage() ?? "This link is for a server you don't have configured."}</p>
          <div class="form-field join-manual-host">
            <label class="field-label" for="join-manual-host">Host</label>
            <input id="join-manual-host" value={manualHost()} onInput={(e) => setManualHost(e.currentTarget.value)} placeholder="hostname" />
            <label class="field-label" for="join-manual-port">Port</label>
            <input id="join-manual-port" type="number" value={manualPort()} onInput={(e) => setManualPort(parseInt(e.currentTarget.value) || 443)} />
          </div>
          <div class="actions actions-center">
            <button class="btn-ghost" type="button" onClick={goHome}>Cancel</button>
            <button class="btn-primary" type="button" disabled={!manualHost().trim()} onClick={tryManualHost}>Try this host</button>
          </div>
        </Show>

        <Show when={step() === "confirm" && grantInfo()}>
          {(info) => (
            <>
              <h2>You're invited</h2>
              <Show when={info().issuerDisplayName}>
                <p><strong>{info().issuerDisplayName}</strong> is inviting you with the message</p>
              </Show>
              <Show when={info().greeting}>
                <div class="offer-name">"{info().greeting}"</div>
              </Show>
              <p class="field-hint">
                Tapping Join creates an account for you on this server — this is not anonymous, and the person who
                invited you can see that you joined.
              </p>
              <Show when={unboundBoards() > 0}>
                <div class="form-field join-keep-choice">
                  <div class="field-hint field-hint-lead">
                    You already have {unboundBoards()} board{unboundBoards() > 1 ? "s" : ""} on this device from before joining.
                  </div>
                  <fieldset class="join-keep-options">
                    <legend class="sr-only">What to do with the boards already on this device</legend>
                    <label class="check-label">
                      <input type="radio" name="keep-choice" checked={keepChoice() !== "discard"} onChange={() => setKeepChoice("keep")} />
                      Keep it — it becomes part of your new account
                    </label>
                    <label class="check-label">
                      <input type="radio" name="keep-choice" checked={keepChoice() === "discard"} onChange={() => setKeepChoice("discard")} />
                      Discard it
                    </label>
                  </fieldset>
                </div>
              </Show>
              <div class="actions actions-center">
                <button class="btn-ghost" type="button" onClick={goHome}>Cancel</button>
                <button class="btn-primary" type="button" onClick={doJoin}>Join</button>
              </div>
            </>
          )}
        </Show>

        <Show when={step() === "joining"}>
          <div class="receive-syncing">
            <div class="spinner" />
            <div>Joining…</div>
          </div>
        </Show>

        <Show when={step() === "success"}>
          <div class="receive-saved">
            <div class="receive-saved-icon">✓</div>
            <div>You're in!</div>
          </div>
          <div class="actions actions-center">
            <button class="btn-primary" type="button" onClick={goHome}>Go to app</button>
          </div>
        </Show>

        <Show when={step() === "error"}>
          <h2>Couldn't join</h2>
          <p class="field-error" role="alert">{errorMessage()}</p>
          <div class="actions actions-center">
            <button class="btn-ghost" type="button" onClick={goHome}>Go home</button>
          </div>
        </Show>
      </div>
    </div>
  );
};

export default JoinPage;
