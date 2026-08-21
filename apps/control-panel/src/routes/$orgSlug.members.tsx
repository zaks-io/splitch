import { Alert, AlertDescription, AlertTitle } from "@splitch/ui/components/alert";
import { createFileRoute } from "@tanstack/react-router";
import { OrgMembersPage } from "#components/org-members-page";
import { OrganizationsTruncatedNotice } from "#components/organizations-truncated-notice";
import { PanelPageHeader } from "#components/panel-page-header";
import { PanelShell } from "#components/panel-shell";
import { loginRedirect } from "#lib/login-redirect";
import { loadOrgMembers } from "#lib/org-members-functions";
import { loadPanelNavigation } from "#lib/session-functions";

export const Route = createFileRoute("/$orgSlug/members")({
  loader: async ({ location, params }) => {
    const [members, panel] = await Promise.all([
      loadOrgMembers({ data: params.orgSlug }),
      loadPanelNavigation(),
    ]);
    if (members.kind === "unauthenticated" || panel.kind === "unauthenticated") {
      throw loginRedirect(location.href);
    }
    return {
      view: members.kind === "ok" ? members.view : null,
      truncatedLimit: members.kind === "truncated" ? members.limit : null,
      panel,
    };
  },
  component: OrganizationMembersRoute,
});

function OrganizationMembersRoute() {
  const { panel, truncatedLimit, view } = Route.useLoaderData();

  if (truncatedLimit !== null) {
    return (
      <div className="mx-auto w-full max-w-6xl px-6 py-8">
        <OrganizationsTruncatedNotice limit={truncatedLimit} />
      </div>
    );
  }

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
      <PanelPageHeader crumb={view.orgSlug} title="Members" />
      <div className="px-8 py-6">
        <OrgMembersPage view={view} />
      </div>
    </PanelShell>
  );
}
