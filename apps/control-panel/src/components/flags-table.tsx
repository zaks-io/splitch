import { Card, CardContent, CardHeader } from "@splitch/ui/components/card";
import { Table, TableBody, TableHead, TableHeader, TableRow } from "@splitch/ui/components/table";
import type { FlagsPageItem } from "#lib/flags-page-data";
import { FlagsTableRow } from "./flags-table-row";

export function FlagsTable({
  appSlug,
  env,
  items,
  orgSlug,
}: {
  appSlug: string;
  env: string;
  items: FlagsPageItem[];
  orgSlug: string;
}) {
  return (
    <Card>
      <CardHeader className="border-border border-b py-4">
        <p className="text-muted-foreground text-sm">
          Flag Configuration in <span className="font-medium text-foreground">{env}</span>
        </p>
      </CardHeader>
      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="px-4">Flag key</TableHead>
              <TableHead>Enabled</TableHead>
              <TableHead>Rollout</TableHead>
              <TableHead className="pr-4 text-right">Available Variants</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((item) => (
              <FlagsTableRow
                appSlug={appSlug}
                env={env}
                item={item}
                key={item.definition.id}
                orgSlug={orgSlug}
              />
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
