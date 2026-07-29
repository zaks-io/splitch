import { Badge } from "@splitch/ui/components/badge";

/**
 * The lock affordance for a field group a running Experiment owns.
 *
 * Anything frozen must LOOK frozen, and the marker always carries a one-line
 * reason — a disabled control with no explanation reads as a bug, not a policy.
 * This marker is never rendered for the kill switch (see `isLocked`).
 */
export function FlagDetailLock({ experimentName }: { experimentName: string }) {
  return (
    <span className="flex flex-wrap items-center gap-2" data-flag-lock="true">
      <Badge variant="outline" className="font-mono text-[0.65rem] uppercase tracking-[0.14em]">
        Locked
      </Badge>
      <span className="text-muted-foreground text-xs leading-5">
        owned by Experiment {experimentName} while it runs
      </span>
    </span>
  );
}
