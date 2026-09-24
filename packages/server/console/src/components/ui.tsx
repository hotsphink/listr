import { For, Show, createSignal, type JSX } from "solid-js";
import type { ConsoleSeries } from "@listr/shared";
import { pretty } from "../format";

/** A small line chart of a per-minute series, with the latest value called out. */
export function Sparkline(props: { series: ConsoleSeries; tone?: "accent" | "bad"; label: string }) {
  const W = 160;
  const H = 32;
  const points = () => {
    const v = props.series.values;
    const max = Math.max(1, ...v);
    return v.map((y, i) => `${((i / Math.max(1, v.length - 1)) * W).toFixed(1)},${(H - 2 - (y / max) * (H - 4)).toFixed(1)}`).join(" ");
  };
  const total = () => props.series.values.reduce((a, b) => a + b, 0);
  const peak = () => Math.max(0, ...props.series.values);
  return (
    <figure class="spark">
      <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="img" aria-label={`${props.label}: ${total()} in the last hour, peak ${peak()} per minute`}>
        <polyline class={`spark-line ${props.tone ?? "accent"}`} points={points()} />
      </svg>
      <figcaption>
        <span>{props.label}</span>
        <span class="num">{total()}/h</span>
      </figcaption>
    </figure>
  );
}

export type Tone = "good" | "warn" | "bad" | "muted" | "info";

export function Badge(props: { tone: Tone; children: JSX.Element; title?: string }) {
  return <span class={`badge ${props.tone}`} title={props.title}>{props.children}</span>;
}

export function stateTone(state: string | null | undefined): Tone {
  if (state === "active" || state === "complete" || state === "authenticated" || state === "outstanding") return "good";
  if (state === "suspended" || state === "needs_grant" || state === "quota" || state === "ambiguous" || state === "stale" || state === "expired") return "warn";
  if (state === "revoked" || state === "error" || state === "config_error" || state === "burned") return "bad";
  if (state === "running" || state === "challenged" || state === "connecting") return "info";
  return "muted";
}

export function StateBadge(props: { state: string | null | undefined }) {
  return <Badge tone={stateTone(props.state)}>{props.state ?? "-"}</Badge>;
}

export function Stat(props: { label: string; value: JSX.Element; sub?: JSX.Element; tone?: Tone; href?: string }) {
  const body = (
    <>
      <div class="stat-label">{props.label}</div>
      <div class={`stat-value num ${props.tone ?? ""}`}>{props.value}</div>
      <Show when={props.sub}><div class="stat-sub">{props.sub}</div></Show>
    </>
  );
  return (
    <Show when={props.href} fallback={<div class="stat">{body}</div>}>
      <a class="stat link" href={props.href}>{body}</a>
    </Show>
  );
}

/** Collapsible pretty-printed JSON. */
export function Json(props: { value: unknown; open?: boolean; summary?: string }) {
  return (
    <details class="json" open={props.open}>
      <summary>{props.summary ?? "JSON"}</summary>
      <pre>{pretty(props.value)}</pre>
    </details>
  );
}

export function KV(props: { rows: [string, JSX.Element][] }) {
  return (
    <dl class="kv">
      <For each={props.rows}>{([k, v]) => <><dt>{k}</dt><dd>{v}</dd></>}</For>
    </dl>
  );
}

export function Loading(props: { error?: string | null }) {
  return (
    <Show when={props.error} fallback={<p class="muted">Loading...</p>}>
      <p class="error-text" role="alert">{props.error}</p>
    </Show>
  );
}

/** A bar showing used out of limit, with the numbers beside it. */
export function Meter(props: { used: number; limit: number | null; label: string }) {
  const frac = () => (props.limit ? Math.min(1, props.used / props.limit) : 0);
  const tone = () => (frac() >= 1 ? "bad" : frac() >= 0.8 ? "warn" : "good");
  return (
    <div class="meter">
      <div class="meter-head">
        <span>{props.label}</span>
        <span class="num">{props.used}{props.limit !== null ? ` / ${props.limit}` : ""}</span>
      </div>
      <Show when={props.limit !== null}>
        <div class="meter-track" role="meter" aria-valuenow={props.used} aria-valuemin={0} aria-valuemax={props.limit ?? 0} aria-label={props.label}>
          <div class={`meter-fill ${tone()}`} style={{ width: `${frac() * 100}%` }} />
        </div>
      </Show>
    </div>
  );
}

export function CopyId(props: { id: string; n?: number }) {
  const [copied, setCopied] = createSignal(false);
  return (
    <button
      type="button"
      class="copy-id mono"
      title={`${props.id} (click to copy)`}
      onClick={(e) => {
        e.stopPropagation();
        void navigator.clipboard?.writeText(props.id).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        });
      }}
    >
      {copied() ? "copied" : props.id.slice(0, props.n ?? 8)}
    </button>
  );
}
