"use client";

import { usePathname } from "next/navigation";
import { useEffect } from "react";

/**
 * Re-applies the stored theme after every client-side navigation.
 *
 * The inline script in <head> sets the `dark` class before first paint (no
 * flash), but it only runs on a full page load. Soft navigations — e.g. the
 * header's locale switcher calling router.push — re-render <html> and drop the
 * class, which reset the page to light mode. This keeps the class in sync with
 * the stored preference on every route change.
 */
export function ThemeSync() {
  const pathname = usePathname();

  useEffect(() => {
    const stored = localStorage.getItem("theme");
    const dark =
      stored === "dark" ||
      (!stored && window.matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.classList.toggle("dark", dark);
  }, [pathname]);

  return null;
}
