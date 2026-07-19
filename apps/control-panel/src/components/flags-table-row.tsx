import { Badge } from "@splitch/ui/components/badge";
import { TableCell, TableRow } from "@splitch/ui/components/table";
import type { FlagsPageItem } from "#lib/flags-page-data";

export function FlagsTableRow({
  appSlug,
  env,
  item,
  orgSlug,
}: {
  appSlug: string;
  env: string;
  item: FlagsPageItem;
  orgSlug: string;
}) {
  const config = item.configuration;
  const href = `/${encodeURIComponent(orgSlug)}/${encodeURIComponent(appSlug)}/${encodeURIComponent(env)}/flags/${encodeURIComponent(item.definition.key)}`;

  return (
    <TableRow data-flag-key={item.definition.key}>
      <TableCell className="px-4">
        <a className="font-mono font-medium text-foreground hover:underline" href={href}>
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
        {config ? `${config.availableVariantCount} of ${item.definition.variantCount}` : "—"}
      </TableCell>
    </TableRow>
  );
}

function rolloutSummary(percentages: number[]): string {
  if (percentages.length === 0) return "No percentage rollout";
  const values = percentages.map((percentage) => `${formatPercentage(percentage)}%`).join(", ");
  return `${values} ${percentages.length === 1 ? "rollout" : "rollouts"}`;
}

function formatPercentage(value: number): string {
  return Number.isInteger(value) ? value.toFixed(0) : value.toString();
}
