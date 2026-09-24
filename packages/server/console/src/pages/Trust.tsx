import { For, Show, createMemo, createSignal } from "solid-js";
import type { ConsoleAuthEvent, ConsoleGrant, ConsoleKey, ConsoleTrust, ConsoleUser, ConsoleUserDetail } from "@listr/shared";
import { get } from "../api";
import { useLive } from "../components/live";
import { Badge, CopyId, KV, Loading, StateBadge } from "../components/ui";
import { ago, dateTime, short } from "../format";
import { href, navigate } from "../router";

const NODE_W = 168;
const NODE_H = 62;
const GAP_X = 18;
const LEVEL_H = 112;
const PAD = 16;
const KEY_W = 96;
const KEY_H = 30;

interface LaidOut {
  kind: "user" | "grant";
  id: string;
  x: number;
  y: number;
  user?: ConsoleUser;
  grant?: ConsoleGrant;
  parent?: LaidOut;
}

interface KeyNode {
  key: ConsoleKey;
  x: number;
  y: number;
  unclaimed: boolean;
}

export const userName = (u: ConsoleUser | undefined, id?: string | null) =>
  u?.display_name ?? (u ? short(u.user_id) : id ? short(id) : "-");

// A tidy tree: leaves take one slot each, left to right, and a parent sits
// centred over its first and last child. Outstanding grants hang under their
// issuer as leaves.
function layout(trust: ConsoleTrust): { nodes: LaidOut[]; width: number; depth: number } {
  const children = new Map<string | null, ConsoleUser[]>();
  const ids = new Set(trust.users.map((u) => u.user_id));
  for (const u of trust.users) {
    const parent = u.authorized_by && ids.has(u.authorized_by) ? u.authorized_by : null;
    const list = children.get(parent) ?? [];
    list.push(u);
    children.set(parent, list);
  }
  const grantsBy = new Map<string, ConsoleGrant[]>();
  for (const g of trust.grants) {
    if (g.status !== "outstanding") continue;
    const list = grantsBy.get(g.issuer_user_id) ?? [];
    list.push(g);
    grantsBy.set(g.issuer_user_id, list);
  }
  const roots = [...(children.get(null) ?? [])].sort((a, b) =>
    a.user_id === trust.root_user_id ? -1 : b.user_id === trust.root_user_id ? 1 : a.created_at - b.created_at);

  const nodes: LaidOut[] = [];
  let slot = 0;
  let depth = 0;
  const slotX = (s: number) => PAD + s * (NODE_W + GAP_X);

  const place = (u: ConsoleUser, level: number, parent?: LaidOut): LaidOut => {
    depth = Math.max(depth, level);
    const node: LaidOut = { kind: "user", id: u.user_id, x: 0, y: PAD + level * LEVEL_H, user: u, parent };
    nodes.push(node);
    const kids: LaidOut[] = [];
    for (const c of children.get(u.user_id) ?? []) kids.push(place(c, level + 1, node));
    for (const g of grantsBy.get(u.user_id) ?? []) {
      depth = Math.max(depth, level + 1);
      const gn: LaidOut = { kind: "grant", id: g.id, x: slotX(slot++), y: PAD + (level + 1) * LEVEL_H, grant: g, parent: node };
      nodes.push(gn);
      kids.push(gn);
    }
    node.x = kids.length ? (kids[0].x + kids[kids.length - 1].x) / 2 : slotX(slot++);
    return node;
  };
  for (const r of roots) place(r, 0);
  return { nodes, width: slotX(Math.max(slot, 1)) + PAD, depth };
}

function sourceLabel(source: string | null): string {
  if (!source) return "unknown";
  if (source.startsWith("grant:")) return `grant ${short(source.slice(6))}`;
  return source;
}

function stateFill(u: ConsoleUser): string {
  if (u.effective_state === "revoked") return "node-revoked";
  if (u.effective_state === "suspended") return "node-suspended";
  return "node-active";
}

function TrustGraph(props: { trust: ConsoleTrust; showKeys: boolean; selected?: string }) {
  const graph = createMemo(() => layout(props.trust));
  const [hoverUser, setHoverUser] = createSignal<string | null>(null);
  const [hoverKey, setHoverKey] = createSignal<string | null>(null);
  const userPos = createMemo(() => new Map(graph().nodes.filter((n) => n.kind === "user").map((n) => [n.id, n])));

  // Home keys held only by their owner are noise here; the user panel lists them.
  const keyNodes = createMemo((): KeyNode[] => {
    if (!props.showKeys) return [];
    const shown = props.trust.keys.filter((k) =>
      k.holders.length === 0 || k.holders.length > 1 || k.holders.some((h) => h.source !== "home"));
    const y = PAD + (graph().depth + 1) * LEVEL_H + 24;
    const span = Math.max(graph().width - 2 * PAD, shown.length * (KEY_W + 12));
    return shown.map((key, i) => ({
      key, y, unclaimed: key.holders.length === 0 && key.items + key.lists + key.boards > 0,
      x: PAD + (shown.length === 1 ? span / 2 : (i * (span - KEY_W)) / Math.max(1, shown.length - 1)) + KEY_W / 2,
    }));
  });

  const width = () => Math.max(graph().width, ...keyNodes().map((k) => k.x + KEY_W / 2 + PAD));
  const height = () => PAD * 2 + (graph().depth + 1) * LEVEL_H + (keyNodes().length ? KEY_H + 40 : 0);

  const litUser = (id: string) => {
    const k = hoverKey();
    if (k) return !!props.trust.keys.find((x) => x.tag === k)?.holders.some((h) => h.user_id === id);
    return hoverUser() === id;
  };
  const litKey = (key: ConsoleKey) => key.tag === hoverKey() || (!!hoverUser() && key.holders.some((h) => h.user_id === hoverUser()));
  const dim = () => !!(hoverUser() || hoverKey());

  const devices = createMemo(() => {
    const map = new Map<string, { connected: boolean }[]>();
    for (const d of props.trust.devices) {
      const list = map.get(d.user_id) ?? [];
      list.push(d);
      map.set(d.user_id, list);
    }
    return map;
  });

  return (
    <div class="graph-scroll">
      <svg class="trust-graph" width={width()} height={height()} viewBox={`0 0 ${width()} ${height()}`} role="group" aria-label="Trust graph">
        <defs>
          <pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <line x1="0" y1="0" x2="0" y2="6" class="hatch-line" />
          </pattern>
        </defs>
        {/* Edges */}
        <For each={graph().nodes.filter((n) => n.parent)}>
          {(n) => {
            const p = n.parent!;
            const x1 = p.x + NODE_W / 2, y1 = p.y + NODE_H, x2 = n.x + NODE_W / 2, y2 = n.y;
            const my = (y1 + y2) / 2;
            const label = n.kind === "grant" ? n.grant!.kind : n.user!.provisional ? "guest" : "invite";
            return (
              <g class={`edge ${n.kind === "grant" ? "edge-grant" : ""}`} classList={{ dim: dim() && !litUser(n.id) && !litUser(p.id) }}>
                <path d={`M${x1},${y1} C${x1},${my} ${x2},${my} ${x2},${y2}`} />
                <text x={x2 + 4} y={y2 - 6} class="edge-label">{label}</text>
              </g>
            );
          }}
        </For>
        {/* Key edges */}
        <For each={keyNodes()}>
          {(k) => (
            <For each={k.key.holders}>
              {(h) => {
                const u = userPos().get(h.user_id);
                if (!u) return null;
                const x1 = u.x + NODE_W / 2, y1 = u.y + NODE_H, x2 = k.x, y2 = k.y;
                return (
                  <path class="key-edge" classList={{ lit: litKey(k.key) && (hoverKey() === k.key.tag || hoverUser() === h.user_id), dim: dim() && !litKey(k.key) }}
                    d={`M${x1},${y1} C${x1},${(y1 + y2) / 2} ${x2},${(y1 + y2) / 2} ${x2},${y2}`} />
                );
              }}
            </For>
          )}
        </For>
        {/* Nodes */}
        <For each={graph().nodes}>
          {(n) => (
            <Show
              when={n.kind === "user"}
              fallback={
                <g class="grant-node" transform={`translate(${n.x},${n.y})`}>
                  <title>{`${n.grant!.kind} grant, expires ${dateTime(n.grant!.expires_at)}, ${n.grant!.attempts}/10 failed attempts`}</title>
                  <rect width={NODE_W} height={NODE_H - 14} rx="8" />
                  <text x="10" y="19" class="node-title">{n.grant!.kind} link</text>
                  <text x="10" y="36" class="node-sub">expires {ago(n.grant!.expires_at)} / {n.grant!.attempts} bad tries</text>
                </g>
              }
            >
              {(() => {
                const u = n.user!;
                const inherited = u.effective_state !== u.state;
                const devs = () => devices().get(u.user_id) ?? [];
                return (
                  <g
                    class={`user-node ${stateFill(u)}`}
                    classList={{ selected: props.selected === u.user_id, provisional: u.provisional, dim: dim() && !litUser(u.user_id) }}
                    transform={`translate(${n.x},${n.y})`}
                    tabindex="0"
                    role="button"
                    aria-label={`User ${userName(u)}, ${u.effective_state}`}
                    onClick={() => navigate("trust", "users", u.user_id)}
                    onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); navigate("trust", "users", u.user_id); } }}
                    onMouseEnter={() => setHoverUser(u.user_id)}
                    onMouseLeave={() => setHoverUser(null)}
                  >
                    <rect width={NODE_W} height={NODE_H} rx="8" />
                    <Show when={inherited}><rect width={NODE_W} height={NODE_H} rx="8" fill="url(#hatch)" class="hatch" /></Show>
                    <text x="10" y="19" class="node-title">
                      {userName(u)}{u.user_id === props.trust.root_user_id ? " (root)" : ""}
                    </text>
                    <text x="10" y="36" class="node-sub">
                      <title>{`caps: ${u.caps.join(", ") || "none"}`}</title>
                      {inherited ? `${u.effective_state} via ancestor` : u.state !== "active" ? u.state : u.caps.join(" ")}
                    </text>
                    <For each={devs().slice(0, 12)}>
                      {(d, i) => <circle cx={14 + i() * 11} cy={NODE_H - 12} r="4" class={d.connected ? "dev-on" : "dev-off"} />}
                    </For>
                    <text x={NODE_W - 10} y={NODE_H - 8} text-anchor="end" class="node-sub">{u.key_count} key{u.key_count === 1 ? "" : "s"}</text>
                  </g>
                );
              })()}
            </Show>
          )}
        </For>
        {/* Keys */}
        <For each={keyNodes()}>
          {(k) => (
            <g class="key-node" classList={{ unclaimed: k.unclaimed, lit: litKey(k.key), dim: dim() && !litKey(k.key) }}
              transform={`translate(${k.x - KEY_W / 2},${k.y})`}
              onMouseEnter={() => setHoverKey(k.key.tag)} onMouseLeave={() => setHoverKey(null)}>
              <title>{`${k.key.name ?? "(unnamed)"} ${k.key.tag}: ${k.key.boards} boards, ${k.key.lists} lists, ${k.key.items} items, ${k.key.holders.length} holders`}</title>
              <rect width={KEY_W} height={KEY_H} rx="15" />
              <text x={KEY_W / 2} y="19" text-anchor="middle" class="key-label">{k.unclaimed ? "UNCLAIMED" : k.key.name ?? k.key.tag}</text>
            </g>
          )}
        </For>
      </svg>
    </div>
  );
}

function GrantRow(props: { g: ConsoleGrant; users: Map<string, ConsoleUser>; showIssuer: boolean }) {
  return (
    <tr>
      <td>{props.g.kind}</td>
      <td><StateBadge state={props.g.status} /></td>
      <Show when={props.showIssuer}>
        <td><a href={href("trust", "users", props.g.issuer_user_id)}>{userName(props.users.get(props.g.issuer_user_id), props.g.issuer_user_id)}</a></td>
      </Show>
      <td>
        <For each={props.g.redemptions} fallback={<span class="muted">-</span>}>
          {(r) => <a href={href("trust", "users", r.user_id)}>{userName(props.users.get(r.user_id), r.user_id)}</a>}
        </For>
      </td>
      <td>{props.g.key_name ?? props.g.key_tag ?? "-"}</td>
      <td title={dateTime(props.g.created_at)}>{ago(props.g.created_at)}</td>
    </tr>
  );
}

function UserPanel(props: { userId: string; users: Map<string, ConsoleUser> }) {
  const { data, error } = useLive(() => get<ConsoleUserDetail>(`/trust/users/${encodeURIComponent(props.userId)}`), { refetchOn: ["trust"] });
  return (
    <aside class="panel card" aria-label="User details">
      <div class="panel-head">
        <h2>User</h2>
        <a href="#/trust" class="ghost" aria-label="Close">Close</a>
      </div>
      <Show when={data()} fallback={<Loading error={error()} />}>
        {(d) => (
          <>
            <KV rows={[
              ["Name", userName(d().user)],
              ["User id", <CopyId id={d().user.user_id} n={12} />],
              ["Caps", d().user.caps.join(", ") || "-"],
              ["State", <><StateBadge state={d().user.state} />{d().user.effective_state !== d().user.state ? <> effective <StateBadge state={d().user.effective_state} /></> : null}</>],
              ["Authorized by", d().user.authorized_by ? <a href={href("trust", "users", d().user.authorized_by!)}>{userName(props.users.get(d().user.authorized_by!), d().user.authorized_by)}</a> : "(none)"],
              ["Guest", d().user.provisional ? "yes" : "no"],
              ["Created", dateTime(d().user.created_at)],
              ["Note", d().user.note ?? "-"],
            ]} />
            <h3>Devices</h3>
            <Show when={d().devices.length} fallback={<p class="muted">None.</p>}>
              <ul class="plain-list">
                <For each={d().devices}>
                  {(dev) => (
                    <li>
                      <span class={`dot ${dev.connected ? "on" : ""}`} aria-label={dev.connected ? "connected" : "offline"} />{" "}
                      <a href={href("clients", dev.client_id)}>{dev.label ?? "(unnamed device)"}</a>{" "}
                      <span class="muted">seen {ago(dev.last_seen)}</span>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
            <h3>Keys</h3>
            <table class="table compact">
              <thead><tr><th>Key</th><th>Name</th><th>Source</th></tr></thead>
              <tbody>
                <For each={d().keys}>
                  {(k) => <tr><td class="mono">{k.tag}</td><td>{k.name ?? "-"}</td><td>{sourceLabel(k.source)}</td></tr>}
                </For>
              </tbody>
            </table>
            <h3>Grants issued</h3>
            <Show when={d().grants_issued.length} fallback={<p class="muted">None.</p>}>
              <table class="table compact">
                <thead><tr><th>Kind</th><th>Status</th><th>Redeemed by</th><th>Key</th><th>Created</th></tr></thead>
                <tbody><For each={d().grants_issued}>{(g) => <GrantRow g={g} users={props.users} showIssuer={false} />}</For></tbody>
              </table>
            </Show>
            <Show when={d().redeemed.length}>
              <h3>Joined through</h3>
              <table class="table compact">
                <thead><tr><th>Kind</th><th>Status</th><th>Issuer</th><th>Redeemed by</th><th>Key</th><th>Created</th></tr></thead>
                <tbody><For each={d().redeemed}>{(g) => <GrantRow g={g} users={props.users} showIssuer />}</For></tbody>
              </table>
            </Show>
            <h3>Events</h3>
            <EventList events={d().events} users={props.users} />
          </>
        )}
      </Show>
    </aside>
  );
}

function EventList(props: { events: ConsoleAuthEvent[]; users: Map<string, ConsoleUser> }) {
  const who = (id: string | null) =>
    id ? <a href={href("trust", "users", id)}>{userName(props.users.get(id), id)}</a> : <span class="muted">-</span>;
  return (
    <Show when={props.events.length} fallback={<p class="muted">No events.</p>}>
      <table class="table compact">
        <thead><tr><th>When</th><th>Event</th><th>Actor</th><th>Subject</th></tr></thead>
        <tbody>
          <For each={props.events}>
            {(e) => (
              <tr>
                <td title={dateTime(e.at)}>{ago(e.at)}</td>
                <td class="mono" title={e.detail ?? undefined}>{e.kind}</td>
                <td>{who(e.actor_user_id)}</td>
                <td>{who(e.subject_user_id)}</td>
              </tr>
            )}
          </For>
        </tbody>
      </table>
    </Show>
  );
}

function Timeline(props: { users: Map<string, ConsoleUser> }) {
  const [kind, setKind] = createSignal("");
  const [user, setUser] = createSignal("");
  const query = () => {
    const q = new URLSearchParams({ limit: "200" });
    if (kind()) q.set("kind", kind());
    if (user()) q.set("user", user());
    return q.toString();
  };
  const { data, error, refresh } = useLive(() => get<ConsoleAuthEvent[]>(`/events?${query()}`), { refetchOn: ["trust"] });
  return (
    <section>
      <h2>Events</h2>
      <div class="filters">
        <label>Kind <select value={kind()} onChange={(e) => { setKind(e.currentTarget.value); void refresh(); }}>
          <option value="">all</option>
          <option value="grant_issued">grant issued</option>
          <option value="grant_redeemed">grant redeemed</option>
          <option value="grant_effect">grant effect</option>
          <option value="state_set">state change</option>
          <option value="caps_set">caps change</option>
          <option value="user_">user changes</option>
          <option value="bootstrap">bootstrap</option>
        </select></label>
        <label>User <select value={user()} onChange={(e) => { setUser(e.currentTarget.value); void refresh(); }}>
          <option value="">anyone</option>
          <For each={[...props.users.values()]}>{(u) => <option value={u.user_id}>{userName(u)}</option>}</For>
        </select></label>
      </div>
      <Show when={data()} fallback={<Loading error={error()} />}>
        {(events) => <EventList events={events()} users={props.users} />}
      </Show>
    </section>
  );
}

export function TrustPage(props: { userId?: string }) {
  const { data, error } = useLive(() => get<ConsoleTrust>("/trust"), {
    refetchOn: ["trust", "client.connect", "client.disconnect"],
  });
  const [showKeys, setShowKeys] = createSignal(false);
  const users = createMemo(() => new Map((data()?.users ?? []).map((u) => [u.user_id, u])));
  const unclaimed = () => (data()?.keys ?? []).filter((k) => k.holders.length === 0 && k.items + k.lists + k.boards > 0).length;
  const outstanding = () => (data()?.grants ?? []).filter((g) => g.status === "outstanding").length;

  return (
    <section>
      <h1>Trust graph</h1>
      <Show when={data()} fallback={<Loading error={error()} />}>
        {(t) => (
          <>
            <div class="toolbar">
              <span class="muted">{t().users.length} users, {t().devices.length} devices, {outstanding()} outstanding links</span>
              <Show when={unclaimed()}><Badge tone="bad">{unclaimed()} unclaimed key{unclaimed() === 1 ? "" : "s"}</Badge></Show>
              <label class="toggle">
                <input type="checkbox" checked={showKeys()} onChange={(e) => setShowKeys(e.currentTarget.checked)} /> Show shared keys
              </label>
            </div>
            <div class="legend" aria-hidden="true">
              <span><i class="sw node-active" /> active</span>
              <span><i class="sw node-suspended" /> suspended</span>
              <span><i class="sw node-revoked" /> revoked</span>
              <span><i class="sw hatch-sw" /> via ancestor</span>
              <span><i class="sw dashed" /> guest</span>
              <span><i class="dot on" /> device online</span>
            </div>
            <div class="trust-layout" classList={{ "with-panel": !!props.userId }}>
              <div class="card graph-card">
                <Show when={t().users.length} fallback={<p class="muted">No users yet.</p>}>
                  <TrustGraph trust={t()} showKeys={showKeys()} selected={props.userId} />
                </Show>
              </div>
              <Show when={props.userId} keyed>{(id) => <UserPanel userId={id} users={users()} />}</Show>
            </div>
          </>
        )}
      </Show>
      <Timeline users={users()} />
    </section>
  );
}
