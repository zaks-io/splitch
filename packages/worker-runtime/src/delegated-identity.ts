import {
  type AccessTokenAuthorization,
  type AuthKind,
  MEMBERSHIP_WIDE_READ_AUTHORIZATION,
} from "@splitch/contracts";
import type { PrincipalMemberships } from "./principal";

export interface DelegatedIdentity {
  operation: string;
  actorId: string;
  authKind?: AuthKind;
  scopes?: readonly string[];
  authorization?: AccessTokenAuthorization;
  memberships?: PrincipalMemberships;
  orgId: string | null;
  appId: string | null;
  environmentId: string | null;
}

export function parseDelegatedIdentity(value: string | null): DelegatedIdentity | null {
  if (!value) return null;
  try {
    const candidate = JSON.parse(value) as Record<string, unknown>;
    return isDelegatedIdentity(candidate) ? (candidate as unknown as DelegatedIdentity) : null;
  } catch {
    return null;
  }
}

export function delegatedAxisCovers(
  identity: DelegatedIdentity,
  axis: "orgId" | "appId" | "environmentId",
  value: string,
): boolean {
  if (identity[axis] !== value) return false;
  if (identity.authorization !== MEMBERSHIP_WIDE_READ_AUTHORIZATION || axis === "environmentId") {
    return true;
  }
  const memberships = requireDelegatedMemberships(identity);
  return axis === "orgId"
    ? memberships.organizations.some((membership) => membership.id === value)
    : memberships.apps.some((membership) => membership.id === value);
}

function requireDelegatedMemberships(identity: DelegatedIdentity): PrincipalMemberships {
  if (!identity.memberships) {
    throw new Error("worker-runtime: delegated membership-wide identity has no live memberships");
  }
  return identity.memberships;
}

function isDelegatedIdentity(candidate: Record<string, unknown>): boolean {
  return (
    isNonEmptyString(candidate.operation) &&
    isNonEmptyString(candidate.actorId) &&
    isScopeAxis(candidate.orgId) &&
    isScopeAxis(candidate.appId) &&
    isScopeAxis(candidate.environmentId) &&
    (candidate.authKind === undefined || isAuthKind(candidate.authKind)) &&
    (candidate.scopes === undefined || isStringArray(candidate.scopes)) &&
    hasCompatibleWideAuthority(candidate)
  );
}

function hasCompatibleWideAuthority(candidate: Record<string, unknown>): boolean {
  if (candidate.authorization === undefined && candidate.memberships === undefined) return true;
  return (
    candidate.authorization === MEMBERSHIP_WIDE_READ_AUTHORIZATION &&
    isStringArray(candidate.scopes) &&
    candidate.scopes.length === 0 &&
    isPrincipalMemberships(candidate.memberships)
  );
}

function isPrincipalMemberships(value: unknown): value is PrincipalMemberships {
  if (!value || typeof value !== "object") return false;
  const memberships = value as Record<string, unknown>;
  if (
    !Array.isArray(memberships.organizations) ||
    !memberships.organizations.every(isOrganizationMembership) ||
    !Array.isArray(memberships.apps) ||
    !memberships.apps.every(isAppMembership)
  ) {
    return false;
  }
  const organizationIds = new Set(
    memberships.organizations.map((membership) => (membership as { id: string }).id),
  );
  return memberships.apps.every((membership) =>
    organizationIds.has((membership as { organizationId: string }).organizationId),
  );
}

function isOrganizationMembership(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const membership = value as Record<string, unknown>;
  return isNonEmptyString(membership.id) && isUserRole(membership.role);
}

function isAppMembership(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const membership = value as Record<string, unknown>;
  return (
    isNonEmptyString(membership.id) &&
    isNonEmptyString(membership.organizationId) &&
    isUserRole(membership.role)
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isScopeAxis(value: unknown): value is string | null {
  return value === null || isNonEmptyString(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isAuthKind(value: unknown): value is AuthKind {
  return [
    "public",
    "control-plane-token",
    "client-key",
    "api-key",
    "internal-worker",
    "data-plane-key",
  ].includes(String(value));
}

function isUserRole(value: unknown): boolean {
  return value === "owner" || value === "admin" || value === "member";
}
