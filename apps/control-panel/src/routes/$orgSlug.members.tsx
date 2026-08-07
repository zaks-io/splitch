import { Alert, AlertDescription, AlertTitle } from "@splitch/ui/components/alert";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { OrgMembersPage } from "#components/org-members-page";
import { OrgShell } from "#components/org-shell";
import { loadOrgMembers } from "#lib/org-members-functions";
import { loadCurrentSession } from "#lib/session-functions";

export const Route = createFileRoute("/$orgSlug/members")({
  loader: async ({ location, params }) => {
    const [members, session] = await Promise.all([
      loadOrgMembers({ data: params.orgSlug }),
      loadCurrentSession(),
    ]);
    if (members.kind === "unauthenticated" || session.kind === "unauthenticated") {
      throw redirect({ href: `/auth/login?returnTo=${encodeURIComponent(location.href)}` });
    }
    return {
      view: members.kind === "ok" ? members.view : null,
      orgs: session.session.orgs.map((org) => ({ orgId: org.orgId, orgSlug: org.orgSlug })),
      userId: session.session.userId,
    };
  },
  component: OrganizationMembersRoute,
});

function OrganizationMembersRoute() {
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
      <OrgMembersPage view={view} />
    </OrgShell>
  );
}
