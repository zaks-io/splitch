import { Badge } from "@splitch/ui/components/badge";
import { TableCell, TableRow } from "@splitch/ui/components/table";
import type { FlagsPageItem } from "#lib/flags-page-data";

export function FlagsTableRow({ item, scopeHref }: { item: FlagsPageItem; scopeHref: string }) {
  const config = item.configuration;
  const href = `${scopeHref}/flags/${encodeURIComponent(item.definition.key)}`;

  return (
    <TableRow data-flag-key={item.definition.key}>
      <TableCell className="px-4 font-mono font-medium text-foreground">
        <a className="underline underline-offset-4 hover:no-underline" href={href}>
          {item.definition.key}
        </a>
      </TableCell>
      <TableCell>
        {config ? (
          <Badge variant={config.enabled ? "default" : "secondary"}>
            {config.enabled ? "Enabled" : "Disabled"}
          </Badge>
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

/**
 * An empty available set means the Configuration was never narrowed, so the whole
 * catalog is a candidate (flag-editing-ux.md). Reporting it as "0 of 2" reads as
 * "nothing can serve here", the exact reverse, and contradicts the Flag detail
 * screen this row links to.
 */
function availabilitySummary(availableCount: number, catalogCount: number): string {
  if (availableCount === 0) return `All ${catalogCount}, not narrowed`;
  return `${availableCount} of ${catalogCount}`;
}

function rolloutSummary(percentages: number[]): string {
  if (percentages.length === 0) return "No percentage rollout";
  const values = percentages.map((percentage) => `${formatPercentage(percentage)}%`).join(", ");
  return `${values} ${percentages.length === 1 ? "rollout" : "rollouts"}`;
}

function formatPercentage(value: number): string {
  return Number.isInteger(value) ? value.toFixed(0) : value.toString();
}
