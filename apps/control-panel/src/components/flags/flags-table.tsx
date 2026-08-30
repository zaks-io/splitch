import { Card, CardContent, CardHeader } from "@splitch/ui/components/card";
import { Table, TableBody, TableHead, TableHeader, TableRow } from "@splitch/ui/components/table";
import type { FlagsPageItem } from "#lib/flags/flags-page-data";
import { FlagsTableRow } from "#components/flags/flags-table-row";

export function FlagsTable({
  appId,
  env,
  environmentId,
  items,
  scopeHref,
}: {
  appId: string;
  env: string;
  environmentId: string;
  items: FlagsPageItem[];
  scopeHref: string;
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
                appId={appId}
                env={env}
                environmentId={environmentId}
                item={item}
                key={item.definition.id}
                scopeHref={scopeHref}
              />
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
