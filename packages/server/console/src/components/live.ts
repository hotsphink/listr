import { createSignal, onCleanup } from "solid-js";
import type { ConsoleTopic } from "@listr/shared";
import { onTopic, throttle } from "../api";

/**
 * Fetch once, then keep the value fresh from the live stream. A topic whose
 * payload is the new value replaces it directly; any other topic triggers a
 * throttled refetch.
 */
export function useLive<T>(
  fetcher: () => Promise<T>,
  opts: { replaceOn?: ConsoleTopic[]; refetchOn?: ConsoleTopic[]; throttleMs?: number } = {},
) {
  const [data, setData] = createSignal<T | undefined>(undefined);
  const [error, setError] = createSignal<string | null>(null);

  const refresh = async () => {
    try {
      const value = await fetcher();
      setData(() => value);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };
  const throttled = throttle(() => void refresh(), opts.throttleMs ?? 1000);

  const offs = [
    ...(opts.replaceOn ?? []).map((t) => onTopic(t, (payload) => { if (payload) setData(() => payload as T); })),
    ...(opts.refetchOn ?? []).map((t) => onTopic(t, throttled)),
  ];
  onCleanup(() => offs.forEach((off) => off()));
  void refresh();

  return { data, error, refresh };
}
