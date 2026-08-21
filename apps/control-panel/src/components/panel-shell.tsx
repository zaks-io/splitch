import type { ReactNode } from "react";
import { PanelSidebar, type PanelSidebarProps } from "#components/panel-sidebar";
import { useHydrated } from "#lib/use-hydrated";

export type PanelShellProps = {
  children: ReactNode;
  sidebar: PanelSidebarProps;
  markers: Record<`data-${string}`, string>;
  rootKey?: string;
};

export function PanelShell({ children, markers, rootKey, sidebar }: PanelShellProps) {
  const isHydrated = useHydrated();

  return (
    <div
      className="flex min-h-screen bg-background flex-col md:flex-row"
      data-hydrated={isHydrated ? "true" : "false"}
      data-panel-shell="ready"
      key={rootKey}
      {...markers}
    >
      <PanelSidebar {...sidebar} />
      <main className="min-w-0 flex-1" data-panel-main>
        {children}
      </main>
    </div>
  );
}
