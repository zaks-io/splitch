import type { UserRole } from "@splitch/contracts";
import type { OrgRole } from "./session";

export interface OrgMember {
  readonly userId: string;
  /** Resolved from WorkOS by the Control Plane; splitch stores no user profile. */
  readonly email: string;
  readonly role: UserRole;
}

/**
 * Either the Organization's membership, or the reason it is not on screen.
 * There is no "empty list" fallback: a role that may not read membership and an
 * Organization with no members would otherwise render identically, which is the
 * disguised failure ADR-0036 forbids.
 */
export type OrgMemberList =
  | { readonly kind: "ready"; readonly items: readonly OrgMember[] }
  | { readonly kind: "locked"; readonly message: string }
  | { readonly kind: "unavailable"; readonly message: string };

export interface OrgMembersView {
  readonly orgId: string;
  readonly orgSlug: string;
  readonly orgRole: OrgRole;
  /** The signed-in User, so the screen can mark their own row and their own risk. */
  readonly userId: string;
  readonly members: OrgMemberList;
}

/**
 * These gates mirror the Control Plane's own membership gates
 * (`apps/control-plane-api/src/org-handlers.ts`), which are the enforcement
 * boundary. The Panel renders them so a refusal is legible before it happens
 * (ADR-0023); it never substitutes for them.
 *
 * They are deliberately NOT the Org role matrix in
 * `docs/spec/control-plane/organization-and-membership.md`, which reads as if a
 * member may view the list and an admin may change roles. The shipped Worker
 * lists at owner+admin and mutates roles at owner-only, and the derived MCP gate
 * table agrees. Following the endpoint keeps the Panel honest; the spec
 * divergence is reported for a separate decision, not resolved inside a UI slice.
 */
export function canViewOrgMembers(role: OrgRole): boolean {
  return role === "owner" || role === "admin";
}

export function canAddOrgMember(role: OrgRole): boolean {
  return role === "owner" || role === "admin";
}

/** An admin may add a member, but minting an owner is owner-only. */
export function canGrantOrgRole(role: OrgRole, granted: UserRole): boolean {
  return canAddOrgMember(role) && (granted !== "owner" || role === "owner");
}

export function canChangeOrgMemberRole(role: OrgRole): boolean {
  return role === "owner";
}

export function canRemoveOrgMember(role: OrgRole): boolean {
  return role === "owner";
}

/** Org role matrix: SSO/SCIM configuration is owner+admin. */
export function canConfigureSso(role: OrgRole): boolean {
  return role === "owner" || role === "admin";
}

/** Org role matrix: trusted IdPs are owner-only. */
export function canManageTrustedIdps(role: OrgRole): boolean {
  return role === "owner";
}

/**
 * The Worker refuses the change that would leave an Organization ownerless
 * (`LAST_OWNER_REQUIRED`). Naming it up front turns that refusal into an
 * explanation instead of a surprise, and the Worker still has the last word.
 */
export function isLastOwner(members: readonly OrgMember[], userId: string): boolean {
  const owners = members.filter((member) => member.role === "owner");
  return owners.length === 1 && owners[0]?.userId === userId;
}

export function assignableRoles(actorRole: OrgRole): readonly UserRole[] {
  return actorRole === "owner" ? ["owner", "admin", "member"] : ["admin", "member"];
}

export const ORG_MEMBERS_LOCKED_MESSAGE =
  "Only owners and admins can view Organization membership.";
