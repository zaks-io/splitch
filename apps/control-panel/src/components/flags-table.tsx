import { Card, CardContent, CardHeader } from "@splitch/ui/components/card";
import { Table, TableBody, TableHead, TableHeader, TableRow } from "@splitch/ui/components/table";
import type { UrlScope } from "#lib/app-shell-navigation";
import type { FlagsPageItem } from "#lib/flags-page-data";
import { FlagsTableRow } from "./flags-table-row";

export function FlagsTable({
  env,
  items,
  scope,
}: {
  env: string;
  items: FlagsPageItem[];
  scope: UrlScope;
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
              <FlagsTableRow item={item} key={item.definition.id} scope={scope} />
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
