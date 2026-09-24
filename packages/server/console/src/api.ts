import { createSignal } from "solid-js";
import type { ConsoleTopic } from "@listr/shared";

const API = "/console/api";

/** null until the first session check answers. */
export const [authed, setAuthed] = createSignal<boolean | null>(null);
export const [streamUp, setStreamUp] = createSignal(false);

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

async function errorOf(res: Response): Promise<ApiError> {
  let message = res.statusText;
  try {
    message = ((await res.json()) as { error?: string }).error ?? message;
  } catch {
    // Not JSON. Keep the status text.
  }
  if (res.status === 401) setAuthed(false);
  return new ApiError(res.status, message);
}

export async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${API}${path}`, { credentials: "same-origin" });
  if (!res.ok) throw await errorOf(res);
  return (await res.json()) as T;
}

export async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await errorOf(res);
  return (await res.json()) as T;
}

export async function checkSession(): Promise<void> {
  try {
    setAuthed((await get<{ authenticated: boolean }>("/session")).authenticated);
  } catch {
    setAuthed(false);
  }
}

export async function login(password: string): Promise<void> {
  await post("/login", { password });
  setAuthed(true);
}

export async function logout(): Promise<void> {
  await post("/logout", {});
  setAuthed(false);
}

// -- Live stream ----------------------------------------------------------------

type Listener = (data: any) => void;
const listeners = new Map<ConsoleTopic, Set<Listener>>();
let source: EventSource | null = null;

const TOPICS: ConsoleTopic[] = [
  "trust", "integration.run", "integration.stats", "client.connect", "client.disconnect", "client.stats", "ports.stats",
];

export function openStream(): void {
  if (source) return;
  source = new EventSource(`${API}/stream`);
  source.onopen = () => setStreamUp(true);
  source.onerror = () => {
    setStreamUp(false);
    // A closed stream after a failed reconnect usually means the session
    // expired. Check, so the login screen appears instead of a dead page.
    if (source?.readyState === EventSource.CLOSED) {
      closeStream();
      void checkSession();
    }
  };
  for (const topic of TOPICS) {
    source.addEventListener(topic, (e) => {
      const data = JSON.parse((e as MessageEvent).data);
      for (const fn of listeners.get(topic) ?? []) fn(data);
    });
  }
}

export function closeStream(): void {
  source?.close();
  source = null;
  setStreamUp(false);
}

/** Subscribe to one topic. Returns the unsubscribe function. */
export function onTopic(topic: ConsoleTopic, fn: Listener): () => void {
  let set = listeners.get(topic);
  if (!set) {
    set = new Set();
    listeners.set(topic, set);
  }
  set.add(fn);
  return () => set!.delete(fn);
}

/** Call fn at most once per interval, trailing edge included. */
export function throttle(fn: () => void, ms: number): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending = false;
  return () => {
    if (timer) {
      pending = true;
      return;
    }
    fn();
    timer = setTimeout(function tick() {
      if (pending) {
        pending = false;
        fn();
        timer = setTimeout(tick, ms);
      } else {
        timer = null;
      }
    }, ms);
  };
}
