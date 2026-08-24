/**
 * Theme state.
 *
 * WHY THEME IS NOT IN THE URL
 *
 * Every other piece of view state on this dashboard lives in the URL on purpose,
 * so a view can be sent to someone and arrive identical. Theme is deliberately
 * excluded, because it is a property of the READER rather than of the view: a
 * link that carried it would impose your theme on whoever opened it, and the one
 * thing a shared link should not change about someone else's screen is how bright
 * it is. It lives in localStorage instead, which is per-person and per-device.
 *
 * ABSENT MEANS "FOLLOW THE OS"
 *
 * Only an explicit choice is ever stored. With nothing stored, no `data-theme`
 * attribute is set at all, and `@media (prefers-color-scheme: dark)` in tokens.css
 * decides - so a first-time visitor gets the theme their machine already asked
 * for. The bulb then writes an explicit value, which wins over the OS in BOTH
 * directions (see the :not([data-theme="light"]) guard in tokens.css).
 */

import { useCallback, useEffect, useState } from "react";

export type Theme = "light" | "dark";

/** Shared with the pre-hydration script in index.html - keep the two in step. */
export const STORAGE_KEY = "twrev_theme";

function stored(): Theme | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === "light" || v === "dark" ? v : null;
  } catch {
    // Private mode, or a browser set to block site data. Not an error: the OS
    // preference still applies, and the toggle still works for this page view.
    return null;
  }
}

function systemPrefersDark(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches;
}

/** What is actually on screen right now, explicit choice or OS. */
function effective(): Theme {
  return stored() ?? (systemPrefersDark() ? "dark" : "light");
}

function apply(theme: Theme | null): void {
  const root = document.documentElement;
  if (theme === null) delete root.dataset.theme;
  else root.dataset.theme = theme;
}

export function useTheme(): { theme: Theme; toggle: () => void } {
  const [theme, setTheme] = useState<Theme>(effective);

  // Track the OS while no explicit choice is stored, so a machine that flips to
  // dark at sunset takes the dashboard with it rather than stranding it.
  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const mq = matchMedia("(prefers-color-scheme: dark)");
    const on = () => {
      if (stored() === null) setTheme(mq.matches ? "dark" : "light");
    };
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);

  const toggle = useCallback(() => {
    const next: Theme = effective() === "dark" ? "light" : "dark";
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Unstorable is survivable - the attribute below still themes this view.
    }
    apply(next);
    setTheme(next);
  }, []);

  // Keep the attribute in step with state, including the first paint after
  // hydration, so the pre-hydration script and React cannot disagree.
  useEffect(() => {
    apply(stored() === null ? null : theme);
  }, [theme]);

  return { theme, toggle };
}
