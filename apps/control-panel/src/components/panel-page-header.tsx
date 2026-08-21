import { Badge } from "@splitch/ui/components/badge";
import type { ReactNode } from "react";

export type PanelPageHeaderProps = {
  crumb?: string;
  title: string;
  actions?: ReactNode;
  guarded?: boolean;
};

export function PanelPageHeader({ actions, crumb, guarded, title }: PanelPageHeaderProps) {
  return (
    <header
      className={`flex h-14 items-center justify-between gap-4 border-b border-border px-8${
        guarded ? " bg-warning-muted/40" : ""
      }`}
    >
      <div className="flex min-w-0 items-center gap-3">
        {crumb ? (
          <span className="shrink-0 font-mono text-[10px] text-muted-foreground uppercase tracking-[0.14em]">
            {crumb}
          </span>
        ) : null}
        <h1 className="truncate text-lg font-semibold tracking-tight">{title}</h1>
        {guarded ? (
          <Badge className="bg-warning-muted text-warning-foreground" variant="outline">
            Policy confirms changes
          </Badge>
        ) : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </header>
  );
}
