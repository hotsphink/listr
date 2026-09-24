const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** "3m ago", "in 2h". */
export function ago(ts: number | null | undefined, now = Date.now()): string {
  if (!ts) return "never";
  const d = now - ts;
  const future = d < 0;
  const s = span(Math.abs(d));
  if (s === "0s") return "just now";
  return future ? `in ${s}` : `${s} ago`;
}

/** "1h 4m", "12s", "3d 2h". */
export function span(ms: number): string {
  if (ms >= DAY) return `${Math.floor(ms / DAY)}d ${Math.floor((ms % DAY) / HOUR)}h`;
  if (ms >= HOUR) return `${Math.floor(ms / HOUR)}h ${Math.floor((ms % HOUR) / MIN)}m`;
  if (ms >= MIN) return `${Math.floor(ms / MIN)}m ${Math.floor((ms % MIN) / SEC)}s`;
  return `${Math.floor(ms / SEC)}s`;
}

export function ms(n: number | null | undefined): string {
  if (n === null || n === undefined) return "-";
  return n >= 1000 ? `${(n / 1000).toFixed(1)}s` : `${Math.round(n)}ms`;
}

export function dateTime(ts: number | null | undefined): string {
  if (!ts) return "-";
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function time(ts: number): string {
  return dateTime(ts).slice(11);
}

export function bytes(n: number | null | undefined): string {
  if (n === null || n === undefined) return "-";
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

export function short(id: string | null | undefined, n = 8): string {
  return id ? id.slice(0, n) : "-";
}

export function sum(values: Record<string, number>): number {
  return Object.values(values).reduce((a, b) => a + b, 0);
}

export function pretty(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/** Pretty-print a body when it is JSON, else return it as is. */
export function prettyBody(body: string): string {
  try {
    return pretty(JSON.parse(body));
  } catch {
    return body;
  }
}
