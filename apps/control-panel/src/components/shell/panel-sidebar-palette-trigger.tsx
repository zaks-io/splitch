import { Kbd } from "@splitch/ui/components/kbd";
import { useEffect, useState } from "react";
import { panelSidebarLinkClassName } from "#components/shell/panel-sidebar-link-styles";

const APPLE_PLATFORM = /Mac|iPhone|iPad|iPod/;

export function PanelSidebarPaletteTrigger({ onOpen }: { onOpen: () => void }) {
  // Server render cannot know the platform; the Apple label is the hydration-safe
  // default and the effect swaps it once the browser is known.
  const [shortcut, setShortcut] = useState("⌘K");
  useEffect(() => {
    if (!APPLE_PLATFORM.test(navigator.platform)) setShortcut("Ctrl+K");
  }, []);

  return (
    <button
      className={`${panelSidebarLinkClassName} w-full`}
      data-command-palette-trigger
      onClick={onOpen}
      type="button"
    >
      <span>Search or jump to</span>
      <Kbd>{shortcut}</Kbd>
    </button>
  );
}
