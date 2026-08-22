import { Kbd } from "@splitch/ui/components/kbd";
import { panelSidebarLinkClassName } from "#components/panel-sidebar-link-styles";

export function PanelSidebarPaletteTrigger({ onOpen }: { onOpen: () => void }) {
  return (
    <button
      className={`${panelSidebarLinkClassName} w-full`}
      data-command-palette-trigger
      onClick={onOpen}
      type="button"
    >
      <span>Search or jump to</span>
      <Kbd>⌘K</Kbd>
    </button>
  );
}
