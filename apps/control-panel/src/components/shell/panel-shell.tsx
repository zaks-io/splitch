import { type ReactNode, useState } from "react";
import { CommandPalette } from "#components/shell/command-palette";
import { PanelSidebar, type PanelSidebarProps } from "#components/shell/panel-sidebar";
import { useHydrated } from "#lib/shared/use-hydrated";

export type PanelShellProps = {
  children: ReactNode;
  sidebar: Omit<PanelSidebarProps, "onOpenPalette">;
  markers: Record<`data-${string}`, string>;
};

export function PanelShell({ children, markers, sidebar }: PanelShellProps) {
  const isHydrated = useHydrated();
  const [paletteOpen, setPaletteOpen] = useState(false);

  return (
    <div
      className="flex min-h-screen bg-background flex-col md:flex-row"
      data-hydrated={isHydrated ? "true" : "false"}
      data-panel-shell="ready"
      {...markers}
    >
      <PanelSidebar {...sidebar} onOpenPalette={() => setPaletteOpen(true)} />
      <main className="min-w-0 flex-1" data-panel-main>
        {children}
      </main>
      <CommandPalette
        app={sidebar.app}
        navigation={sidebar.navigation}
        onOpenChange={setPaletteOpen}
        open={paletteOpen}
        org={sidebar.org}
      />
    </div>
  );
}
