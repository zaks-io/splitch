import { Alert, AlertDescription, AlertTitle } from "@splitch/ui/components/alert";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { OrgBillingPage } from "#components/org-billing-page";
import { OrgShell } from "#components/org-shell";
import { loadOrgBilling } from "#lib/org-billing-functions";
import { loadCurrentSession } from "#lib/session-functions";

export const Route = createFileRoute("/$orgSlug/billing")({
  loader: async ({ location, params }) => {
    const [billing, session] = await Promise.all([
      loadOrgBilling({ data: params.orgSlug }),
      loadCurrentSession(),
    ]);
    if (billing.kind === "unauthenticated" || session.kind === "unauthenticated") {
      throw redirect({ href: `/auth/login?returnTo=${encodeURIComponent(location.href)}` });
    }
    return {
      view: billing.kind === "ok" ? billing.view : null,
      orgs: session.session.orgs.map((org) => ({ orgId: org.orgId, orgSlug: org.orgSlug })),
      userId: session.session.userId,
    };
  },
  component: BillingRoute,
});

function BillingRoute() {
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
      <OrgBillingPage view={view} />
    </OrgShell>
  );
}
