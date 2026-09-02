import { useEffect, useRef } from "react";
import { useSettingsStore } from "../stores/settingsStore";
import {
  applyResolvedTheme,
  parseThemePreference,
  persistThemePreference,
  readStoredThemePreference,
  resolveTheme,
} from "./theme";

export function ThemeSync() {
  const loaded = useSettingsStore((state) => state.loaded);
  const setting = useSettingsStore((state) => state.settings.theme);
  const booted = useRef(false);

  useEffect(() => {
    const preference = loaded ? parseThemePreference(setting) : readStoredThemePreference();
    if (loaded) persistThemePreference(preference);
    applyResolvedTheme(resolveTheme(preference), booted.current);
    booted.current = true;
    if (preference !== "system") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => applyResolvedTheme(resolveTheme("system"), true);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [loaded, setting]);

  return null;
}
