import { Badge } from "@splitch/ui/components/badge";
import { cn } from "@splitch/ui/lib/utils";
import type { ReactNode } from "react";

export type PanelPageHeaderProps = {
  crumb?: string;
  environment?: { env: string; guarded: boolean };
  id?: string;
  title: string;
  actions?: ReactNode;
};

export function PanelPageHeader({ actions, crumb, environment, id, title }: PanelPageHeaderProps) {
  return (
    <header
      className={cn(
        "flex h-14 items-center justify-between gap-4 border-b border-border px-8",
        environment?.guarded ? "bg-warning-muted/40" : undefined,
      )}
    >
      <div className="flex min-w-0 items-center gap-3">
        {crumb ? (
          <span className="shrink-0 font-mono text-[10px] text-muted-foreground uppercase tracking-[0.14em]">
            {crumb}
          </span>
        ) : null}
        <h1 className="truncate text-lg font-semibold tracking-tight" id={id}>
          {title}
        </h1>
        {environment?.guarded ? (
          <Badge data-environment-guard-badge variant="outline">
            {environment.env}
          </Badge>
        ) : null}
      </div>
      {actions ? <div className="flex min-w-0 items-center gap-2">{actions}</div> : null}
    </header>
  );
}
