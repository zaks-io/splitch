import { cn } from "@splitch/ui/lib/utils";
import type { ReactNode } from "react";
import { ActiveEnvironmentBadge } from "#components/environments/active-environment-badge";

export type PanelPageHeaderProps = {
  crumb?: string;
  environment?: { env: string; guarded: boolean };
  /** The Environment segmented control, rendered after the title on pages that have one. */
  environmentControl?: ReactNode;
  id?: string;
  title: string;
  actions?: ReactNode;
};

export function PanelPageHeader({
  actions,
  crumb,
  environment,
  environmentControl,
  id,
  title,
}: PanelPageHeaderProps) {
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
        <h1 className="shrink-0 truncate text-lg font-semibold tracking-tight" id={id}>
          {title}
        </h1>
        {environmentControl}
        {environment ? (
          <ActiveEnvironmentBadge env={environment.env} guarded={environment.guarded} />
        ) : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </header>
  );
}
