"use client";

import { MoonIcon, SunIcon } from "lucide-react";
import { useCallback, useSyncExternalStore } from "react";
import { Button } from "#components/button";

const STORAGE_KEY = "splitch-theme";

/* Inline this in <head> before paint so an explicit choice applies without a
   flash. No stored choice means the OS decides via color-scheme. */
export const themeInitScript = `(()=>{try{const t=localStorage.getItem(${JSON.stringify(
  STORAGE_KEY,
)});if(t==="dark"||t==="light")document.documentElement.dataset.theme=t}catch{}})()`;

function subscribe(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributeFilter: ["data-theme"] });
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  media.addEventListener("change", onChange);
  return () => {
    observer.disconnect();
    media.removeEventListener("change", onChange);
  };
}

function resolveTheme(): "light" | "dark" {
  const explicit = document.documentElement.dataset.theme;
  if (explicit === "dark" || explicit === "light") return explicit;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/* Flips between light and dark. The choice persists in localStorage and wins
   over the OS; clearing storage returns the site to OS preference. */
function ThemeToggle({ className }: { className?: string }) {
  const theme = useSyncExternalStore(subscribe, resolveTheme, () => "light" as const);

  const toggle = useCallback(() => {
    const next = resolveTheme() === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* private mode: theme still applies for this page view */
    }
  }, []);

  return (
    <Button
      aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
      className={className}
      onClick={toggle}
      size="icon"
      variant="ghost"
    >
      {theme === "dark" ? <SunIcon /> : <MoonIcon />}
    </Button>
  );
}

export { ThemeToggle };
