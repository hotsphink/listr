import { createSignal } from "solid-js";

// Hash routing: `#/clients/abc`. The server falls back to index.html for any
// path anyway, but hashes need no server help and survive the dev proxy.

function current(): string[] {
  return location.hash.replace(/^#\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
}

const [route, setRoute] = createSignal<string[]>(current());
window.addEventListener("hashchange", () => setRoute(current()));

export { route };

export function href(...parts: (string | number)[]): string {
  return `#/${parts.map((p) => encodeURIComponent(String(p))).join("/")}`;
}

export function navigate(...parts: (string | number)[]): void {
  location.hash = href(...parts);
}
