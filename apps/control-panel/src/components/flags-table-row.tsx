import { Badge } from "@splitch/ui/components/badge";
import { TableCell, TableRow } from "@splitch/ui/components/table";
import { availabilitySummary, rolloutSummary } from "#lib/flag-config-summary";
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
