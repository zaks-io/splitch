import { Badge } from "@splitch/ui/components/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@splitch/ui/components/card";
import { canConfigureSso, canManageTrustedIdps } from "#lib/org-members";
import type { OrgRole } from "#lib/session";

/**
 * SSO and SCIM configuration, stubbed visibly rather than faked — the same
 * treatment the Billing screen's payment half gets. The identity provider seam
 * exists (`organizations.workos_org_id`) but nothing writes it yet, so this
 * states that plainly instead of rendering a "not connected" status that would
 * read as a checked fact (ADR-0036).
 *
 * The role gates are still real and rendered: `Configure SSO/SCIM` is
 * owner/admin and `Manage trusted IdPs` is owner-only in the Org role matrix.
 */
export function SsoScimCard({ orgRole }: { orgRole: OrgRole }) {
  return (
    <Card data-testid="sso-scim-card">
      <CardHeader>
        <CardTitle>Single sign-on and directory sync</CardTitle>
        <CardDescription>
          SSO and SCIM provisioning for this Organization are managed by your account team.
          Self-serve configuration is not wired yet, so nothing here reports a connection state.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        <SsoScimRow
          allowed={canConfigureSso(orgRole)}
          detail="Connect an identity provider and enable SCIM user provisioning."
          orgRole={orgRole}
          requiredRole="an Organization owner or admin"
          testId="sso-configure"
          title="Configure SSO and SCIM"
        />
        <SsoScimRow
          allowed={canManageTrustedIdps(orgRole)}
          detail="Decide which identity providers may assert membership of this Organization."
          orgRole={orgRole}
          requiredRole="an Organization owner"
          testId="sso-trusted-idps"
          title="Trusted identity providers"
        />
      </CardContent>
    </Card>
  );
}

function SsoScimRow({
  allowed,
  detail,
  orgRole,
  requiredRole,
  testId,
  title,
}: {
  allowed: boolean;
  detail: string;
  orgRole: OrgRole;
  requiredRole: string;
  testId: string;
  title: string;
}) {
  return (
    <div
      className="flex flex-wrap items-start justify-between gap-3 rounded-md border border-border px-3 py-2"
      data-testid={testId}
    >
      <div className="grid min-w-0 gap-1">
        <span className="font-medium text-sm">{title}</span>
        <span className="text-muted-foreground text-xs">{detail}</span>
        {allowed ? null : (
          <span className="text-muted-foreground text-xs">
            Requires {requiredRole}. Your role is {orgRole}.
          </span>
        )}
      </div>
      <Badge variant="outline">{allowed ? "Contact your account team" : "Locked"}</Badge>
    </div>
  );
}
