import { Alert, AlertDescription, AlertTitle } from "@splitch/ui/components/alert";
import { createFileRoute } from "@tanstack/react-router";
import { OrgIntegrationsPage } from "#components/integrations/org-integrations-page";
import { OrganizationsTruncatedNotice } from "#components/organizations/organizations-truncated-notice";
import { PanelPageBody } from "#components/shell/panel-page-body";
import { PanelPageHeader } from "#components/shell/panel-page-header";
import { PanelShell } from "#components/shell/panel-shell";
import { loginRedirect } from "#lib/auth/login-redirect";
import { loadPanelNavigation } from "#lib/sessions/session-functions";
import { documentTitle } from "#lib/shell/document-title";

export const Route = createFileRoute("/$orgSlug/integrations")({
  loader: async ({ location, params }) => {
    const panel = await loadPanelNavigation();
    if (panel.kind === "unauthenticated") {
      throw loginRedirect(location.href);
    }
    // The session's Org membership is the whole read this screen needs: the
    // installations themselves are fetched by the card against the Control
    // Plane, which enforces the role again.
    const membership = panel.session.orgs.find((org) => org.orgSlug === params.orgSlug) ?? null;
    return {
      panel,
      membership,
      // A capped snapshot cannot tell a non-member from an Organization past the
      // cap, and calling the second one "access denied" would be a wrong answer
      // the User has no way to act on (ADR-0036).
      truncatedLimit: membership || !panel.session.orgsTruncated ? null : panel.session.orgs.length,
    };
  },
  head: ({ params }) => ({ meta: [{ title: documentTitle("Integrations", params.orgSlug) }] }),
  component: OrganizationIntegrationsRoute,
});

function OrganizationIntegrationsRoute() {
  const { membership, panel, truncatedLimit } = Route.useLoaderData();

  if (truncatedLimit !== null) {
    return (
      <div className="mx-auto w-full max-w-6xl px-6 py-8">
        <OrganizationsTruncatedNotice limit={truncatedLimit} />
      </div>
    );
  }

  if (!membership) {
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
      markers={{ "data-org-shell": "ready", "data-org": membership.orgSlug }}
      sidebar={{
        navigation: panel.navigation,
        org: { orgId: membership.orgId, orgSlug: membership.orgSlug },
        userId: panel.session.userId,
      }}
    >
      <PanelPageHeader crumb={membership.orgSlug} title="Integrations" />
      <PanelPageBody>
        <OrgIntegrationsPage orgId={membership.orgId} orgRole={membership.orgRole} />
      </PanelPageBody>
    </PanelShell>
  );
}
