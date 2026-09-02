import type { ThemePreference } from "../types/settings";

export type { ThemePreference };
export type ResolvedTheme = "dark" | "light";

export const THEME_STORAGE_KEY = "replay.theme";

export function parseThemePreference(value: unknown): ThemePreference {
  if (value === "light" || value === "system" || value === "dark") return value;
  return "dark";
}

export function systemPrefersDark(): boolean {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

export function resolveTheme(preference: ThemePreference): ResolvedTheme {
  if (preference === "system") return systemPrefersDark() ? "dark" : "light";
  return preference;
}

export function readStoredThemePreference(): ThemePreference {
  try {
    return parseThemePreference(localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    return "dark";
  }
}

export function persistThemePreference(preference: ThemePreference) {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    /* private mode */
  }
}

export function applyResolvedTheme(theme: ResolvedTheme, animate: boolean) {
  const root = document.documentElement;
  if (!animate) root.classList.add("theme-no-motion");
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
  if (!animate) {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => root.classList.remove("theme-no-motion"));
    });
  }
}
