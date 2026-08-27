import { Alert, AlertDescription, AlertTitle } from "@splitch/ui/components/alert";
import { ParityNote } from "#components/parity-note";
import { SentryIntegrationCard } from "#components/sentry-integration-card";
import { canManageOrgIntegrations, ORG_INTEGRATIONS_LOCKED_MESSAGE } from "#lib/org-integrations";
import { parityHint } from "#lib/parity-hints";
import type { OrgRole } from "#lib/session";

/**
 * The Integrations screen: `/{orgSlug}/integrations`. The tools that receive
 * this whole Organization's Flag activity, not one App's or one Environment's.
 */
export function OrgIntegrationsPage({ orgId, orgRole }: { orgId: string; orgRole: OrgRole }) {
  return (
    <div className="grid gap-6">
      <p className="max-w-2xl text-muted-foreground text-sm leading-6">
        Where this Organization&apos;s Flag activity is published. Integrations that act on a single
        Environment&apos;s credentials or data, such as Convex and Cloudflare, are configured under
        that Environment&apos;s Settings.
      </p>

      {canManageOrgIntegrations(orgRole) ? (
        <SentryIntegrationCard orgId={orgId} />
      ) : (
        <Alert data-testid="integrations-locked">
          <AlertTitle>Integrations are not visible to you</AlertTitle>
          <AlertDescription>{ORG_INTEGRATIONS_LOCKED_MESSAGE}</AlertDescription>
        </Alert>
      )}

      <ParityNote hint={parityHint("sentry_installations_list")} />
    </div>
  );
}
