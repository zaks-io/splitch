import type { OrgRole } from "./session";

/**
 * Who may wire an Organization into a third-party tool.
 *
 * This mirrors the Control Plane's own gate on the Sentry routes
 * (`org:admin` in `mcp-tool-membership-gates.ts`), which is the enforcement
 * boundary. The Panel renders it so a refusal is legible before it happens
 * (ADR-0023); it never substitutes for it.
 */
export function canManageOrgIntegrations(role: OrgRole): boolean {
  return role === "owner" || role === "admin";
}

export const ORG_INTEGRATIONS_LOCKED_MESSAGE =
  "Only owners and admins can manage Organization integrations.";
