import { Badge } from "@splitch/ui/components/badge";
import { Switch } from "@splitch/ui/components/switch";
import { TableCell, TableRow } from "@splitch/ui/components/table";
import { availabilitySummary, rolloutSummary } from "#lib/flag-config-summary";
import { killSwitchIntent } from "#lib/flag-edit-intent";
import type { FlagsPageItem } from "#lib/flags-page-data";
import { useFlagEditing } from "#lib/use-flag-editing";
import { GatedWriteOutcome } from "./gated-write-outcome";

export function FlagsTableRow({
  appId,
  env,
  environmentId,
  item,
  scopeHref,
}: {
  appId: string;
  env: string;
  environmentId: string;
  item: FlagsPageItem;
  scopeHref: string;
}) {
  const config = item.configuration;
  const href = `${scopeHref}/flags/${encodeURIComponent(item.definition.key)}`;
  const editing = useFlagEditing({
    appId,
    environmentId,
    flagId: item.definition.id,
    variantLabels: item.definition.variantLabels,
  });

  return (
    <TableRow
      data-flag-enabled={config ? String(config.enabled) : "unconfigured"}
      data-flag-key={item.definition.key}
    >
      <TableCell className="px-4">
        <div className="grid gap-1">
          <a
            className="font-mono font-medium text-foreground underline underline-offset-4 hover:no-underline"
            href={href}
          >
            {item.definition.key}
          </a>
          <GatedWriteOutcome
            ungatedCopy={`Applied in the ${env} Environment. Nothing was gated.`}
            write={editing}
          />
        </div>
      </TableCell>
      <TableCell>
        {config ? (
          <Switch
            aria-label={`serving ${item.definition.key} in ${env}`}
            checked={config.enabled}
            data-kill-switch-input="true"
            disabled={editing.busy}
            onCheckedChange={(next) => void editing.submit(killSwitchIntent(next === true))}
          />
        ) : (
          <Badge variant="outline">Not configured</Badge>
        )}
      </TableCell>
      <TableCell className="text-muted-foreground">
        {config ? rolloutSummary(config.rolloutPercentages) : "—"}
      </TableCell>
      <TableCell className="pr-4 text-right text-muted-foreground">
        {config
          ? availabilitySummary(config.availableVariantCount, item.definition.variantCount)
          : "—"}
      </TableCell>
    </TableRow>
  );
}
