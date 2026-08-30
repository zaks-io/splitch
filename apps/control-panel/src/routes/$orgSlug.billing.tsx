import { Alert, AlertDescription, AlertTitle } from "@splitch/ui/components/alert";
import { createFileRoute } from "@tanstack/react-router";
import { OrgBillingPage } from "#components/billing/org-billing-page";
import { PanelPageBody } from "#components/shell/panel-page-body";
import { PanelPageHeader } from "#components/shell/panel-page-header";
import { PanelShell } from "#components/shell/panel-shell";
import { loginRedirect } from "#lib/auth/login-redirect";
import { loadOrgBilling } from "#lib/billing/org-billing-functions";
import { loadPanelNavigation } from "#lib/sessions/session-functions";

export const Route = createFileRoute("/$orgSlug/billing")({
  loader: async ({ location, params }) => {
    const [billing, panel] = await Promise.all([
      loadOrgBilling({ data: params.orgSlug }),
      loadPanelNavigation(),
    ]);
    if (billing.kind === "unauthenticated" || panel.kind === "unauthenticated") {
      throw loginRedirect(location.href);
    }
    return {
      view: billing.kind === "ok" ? billing.view : null,
      panel,
    };
  },
  component: BillingRoute,
});

function BillingRoute() {
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

  const organization = panel.session.orgs.find((org) => org.orgSlug === view.orgSlug);
  if (!organization) {
    throw new Error("Billing Organization is missing from the authenticated session");
  }

  return (
    <PanelShell
      markers={{ "data-org-shell": "ready", "data-org": view.orgSlug }}
      sidebar={{
        navigation: panel.navigation,
        org: { orgId: organization.orgId, orgSlug: view.orgSlug },
        userId: panel.session.userId,
      }}
    >
      <PanelPageHeader crumb={view.orgSlug} title="Billing & Usage" />
      <PanelPageBody>
        <OrgBillingPage view={view} />
      </PanelPageBody>
    </PanelShell>
  );
}
