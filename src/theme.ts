// Extracted from App.tsx (code-audit item A-1).
import type {
  ThemePreference, ResolvedTheme,
} from "./types";

export const THEME_STORAGE_KEY = "dbark_theme";

export function readStoredTheme(): ThemePreference {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === "light" || stored === "dark" || stored === "system") {
      return stored;
    }
  } catch { /* localStorage unavailable — fall through to default */ }
  return "system";
}

export function systemPrefersDark(): boolean {
  return typeof window !== "undefined"
    && window.matchMedia?.("(prefers-color-scheme: dark)").matches === true;
}

export function resolveTheme(pref: ThemePreference): ResolvedTheme {
  if (pref === "system") return systemPrefersDark() ? "dark" : "light";
  return pref;
}
