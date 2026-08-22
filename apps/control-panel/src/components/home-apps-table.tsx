import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@splitch/ui/components/card";
import { Table, TableBody, TableHead, TableHeader, TableRow } from "@splitch/ui/components/table";
import { CreateAppDialog } from "#components/create-app-dialog";
import { HomeAppsTableRow } from "#components/home-apps-table-row";
import type { OrgAppListView } from "#lib/org-app-list";

export function HomeAppsTable({ view }: { view: OrgAppListView }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Apps</CardTitle>
        <CardAction>
          <CreateAppDialog orgId={view.orgId} orgRole={view.orgRole} />
        </CardAction>
      </CardHeader>
      <CardContent className="px-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="pl-4">App</TableHead>
              <TableHead>Environments</TableHead>
              <TableHead>Flags</TableHead>
              <TableHead className="pr-4">Attention</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {view.apps.map((app) => (
              <HomeAppsTableRow app={app} key={app.appId} orgSlug={view.orgSlug} />
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
