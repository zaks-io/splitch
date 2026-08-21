import { Badge } from "@splitch/ui/components/badge";
import { Switch } from "@splitch/ui/components/switch";
import { Link } from "@tanstack/react-router";
import { availabilitySummary, rolloutSummary } from "#lib/flag-config-summary";
import { killSwitchIntent } from "#lib/flag-edit-intent";
import type { FlagsMatrixCell as MatrixCell } from "#lib/flags-matrix-data";
import { useFlagEditing } from "#lib/use-flag-editing";
import { GatedWriteOutcome } from "./gated-write-outcome";

export function FlagsMatrixCell({
  appId,
  cell,
  definition,
  detailHref,
  env,
  environmentId,
}: {
  appId: string;
  cell: MatrixCell | null;
  definition: {
    id: string;
    key: string;
    variantCount: number;
    variantLabels: Record<string, string>;
  };
  detailHref: string;
  env: string;
  environmentId: string;
}) {
  const editing = useFlagEditing({
    appId,
    environmentId,
    flagId: definition.id,
    variantLabels: definition.variantLabels,
  });

  return (
    <div className="grid min-w-44 gap-2" data-matrix-cell={env}>
      {cell ? (
        <>
          <div className="flex items-center gap-2">
            <Switch
              aria-label={`serving ${definition.key} in ${env}`}
              checked={cell.enabled}
              data-kill-switch-input="true"
              disabled={editing.busy}
              onCheckedChange={(next) => void editing.submit(killSwitchIntent(next === true))}
            />
            <span className="text-muted-foreground text-xs">
              {rolloutSummary(cell.rolloutPercentages)}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="text-muted-foreground">
              {availabilitySummary(cell.availableVariantCount, definition.variantCount)}
            </span>
            {cell.controllingExperiment ? (
              <Badge title={cell.controllingExperiment.name} variant="outline">
                Experiment
              </Badge>
            ) : null}
            <Link className="text-foreground underline underline-offset-4" to={detailHref}>
              Open
            </Link>
          </div>
          <GatedWriteOutcome
            ungatedCopy={`Applied in ${env}. Nothing was gated.`}
            write={editing}
          />
        </>
      ) : (
        <div className="flex items-center gap-2 text-xs">
          <span className="text-muted-foreground">Not configured</span>
          <Link className="text-foreground underline underline-offset-4" to={detailHref}>
            Configure
          </Link>
        </div>
      )}
    </div>
  );
}
