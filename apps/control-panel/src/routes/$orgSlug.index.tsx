import { Alert, AlertDescription, AlertTitle } from "@splitch/ui/components/alert";
import { createFileRoute } from "@tanstack/react-router";
import { OrgAppListPage } from "#components/org-app-list-page";
import { OrgShell } from "#components/org-shell";
import { loginRedirect } from "#lib/login-redirect";
import { loadOrgAppList } from "#lib/org-app-list-functions";
import { loadCurrentSession } from "#lib/session-functions";

export const Route = createFileRoute("/$orgSlug/")({
  loader: async ({ location, params }) => {
    const [appList, session] = await Promise.all([
      loadOrgAppList({ data: params.orgSlug }),
      loadCurrentSession(),
    ]);
    if (appList.kind === "unauthenticated" || session.kind === "unauthenticated") {
      throw loginRedirect(location.href);
    }
    return {
      view: appList.kind === "ok" ? appList.view : null,
      // The switcher lists every Organization the user is in, which is a session
      // fact rather than a property of the Organization being viewed.
      orgs: session.session.orgs.map((org) => ({ orgId: org.orgId, orgSlug: org.orgSlug })),
      userId: session.session.userId,
    };
  },
  component: OrganizationRoute,
});

function OrganizationRoute() {
  const { orgs, userId, view } = Route.useLoaderData();

  if (!view) {
    return (
      <Alert className="mx-auto max-w-xl" variant="destructive">
        <AlertTitle>Access denied</AlertTitle>
        <AlertDescription>You are not a member of this Organization.</AlertDescription>
      </Alert>
    );
  }

  return (
    <OrgShell orgRole={view.orgRole} orgSlug={view.orgSlug} orgs={orgs} userId={userId}>
      <OrgAppListPage view={view} />
    </OrgShell>
  );
}
