import { createSignal } from "solid-js";

export type ThemePreference = "system" | "light" | "dark" | "high-contrast";

const STORAGE_KEY = "theme-preference";

function applyTheme(pref: ThemePreference) {
  if (pref === "system") {
    document.documentElement.removeAttribute("data-theme");
  } else {
    document.documentElement.setAttribute("data-theme", pref);
  }
}

const stored = (localStorage.getItem(STORAGE_KEY) ?? "system") as ThemePreference;
applyTheme(stored);

export const [themePref, setThemePrefSignal] = createSignal<ThemePreference>(stored);

export function setThemePref(pref: ThemePreference) {
  setThemePrefSignal(pref);
  localStorage.setItem(STORAGE_KEY, pref);
  applyTheme(pref);
}
