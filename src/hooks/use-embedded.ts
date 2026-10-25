"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

/**
 * Whether the CRM is running inside another page's iframe — the TAGHills
 * ERP embeds it next to its own menu and header, so screen width is
 * scarce there. Comparing `self` with `top` is allowed across origins;
 * the try/catch only guards exotic sandboxes, where we assume embedded.
 */
export function isEmbeddedWindow(win?: Window): boolean {
  const w = win ?? (typeof window === "undefined" ? undefined : window);
  if (!w) return false;
  try {
    return w.self !== w.top;
  } catch {
    return true;
  }
}

const noopSubscribe = () => () => {};

/** True inside an iframe. `false` on the server and in the first client render, so hydration matches. */
export function useEmbedded(): boolean {
  return useSyncExternalStore(
    noopSubscribe,
    () => isEmbeddedWindow(),
    () => false,
  );
}

export const COMPACT_MENU_STORAGE_KEY = "wacrm.embedded-menu-compact";

/**
 * Embedded only: show the main menu as an icon rail (the default) or at
 * full width. The choice is remembered on this device. Outside an iframe
 * the menu is never compact.
 */
export function useCompactMenu(embedded: boolean): [boolean, () => void] {
  const [compact, setCompact] = useState(true);
  useEffect(() => {
    try {
      const stored = localStorage.getItem(COMPACT_MENU_STORAGE_KEY);
      // eslint-disable-next-line react-hooks/set-state-in-effect -- restore a saved preference after mount (same pattern as the inbox contact panel)
      if (stored !== null) setCompact(stored === "true");
    } catch {
      // localStorage can throw in private-browsing / sandboxed iframes.
    }
  }, []);
  const toggle = useCallback(() => {
    setCompact((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(COMPACT_MENU_STORAGE_KEY, String(next));
      } catch {
        // Persistence is best-effort.
      }
      return next;
    });
  }, []);
  return [embedded && compact, toggle];
}
