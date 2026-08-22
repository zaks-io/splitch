import { Alert, AlertDescription, AlertTitle } from "@splitch/ui/components/alert";
import { createFileRoute } from "@tanstack/react-router";
import { OrgAppListPage } from "#components/org-app-list-page";
import { PanelPageHeader } from "#components/panel-page-header";
import { PanelShell } from "#components/panel-shell";
import { loginRedirect } from "#lib/login-redirect";
import { loadOrgAppList } from "#lib/org-app-list-functions";
import { loadPanelNavigation } from "#lib/session-functions";

export const Route = createFileRoute("/$orgSlug/")({
  loader: async ({ location, params }) => {
    const [appList, panel] = await Promise.all([
      loadOrgAppList({ data: params.orgSlug }),
      loadPanelNavigation(),
    ]);
    if (appList.kind === "unauthenticated" || panel.kind === "unauthenticated") {
      throw loginRedirect(location.href);
    }
    return {
      view: appList.kind === "ok" ? appList.view : null,
      panel,
    };
  },
  component: OrganizationRoute,
});

function OrganizationRoute() {
  const { panel, view } = Route.useLoaderData();

  if (!view) {
    return (
      <div className="mx-auto w-full max-w-6xl px-6 py-8">
        <Alert className="mx-auto max-w-xl" variant="destructive">
          <AlertTitle>Access denied</AlertTitle>
          <AlertDescription>You are not a member of this Organization.</AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <PanelShell
      markers={{ "data-org-shell": "ready", "data-org": view.orgSlug }}
      sidebar={{
        navigation: panel.navigation,
        org: { orgId: view.orgId, orgSlug: view.orgSlug },
        userId: panel.session.userId,
      }}
    >
      <PanelPageHeader
        actions={
          <span className="font-mono text-[10px] text-muted-foreground uppercase tracking-[0.14em]">
            {view.orgRole}
          </span>
        }
        crumb="Organization"
        title={view.orgSlug}
      />
      <div className="px-8 py-6">
        <OrgAppListPage view={view} />
      </div>
    </PanelShell>
  );
}
