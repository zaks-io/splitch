import type { AppMembership, OrgMembership, StoredSession } from "./session";
import { nowSeconds } from "./session-cookie";

const ORG_ROLES = new Set(["owner", "admin", "member"]);
const APP_ROLES = new Set(["owner", "admin", "member", "viewer"]);
/**
 * Exported so the live-update contract schema can be checked against them. That
 * schema is `.strict()` over this same shape and lives in another package, so a
 * key added here and not there refuses every session at the socket boundary.
 */
export const STORED_SESSION_KEYS = new Set([
  "userId",
  "orgs",
  "orgsTruncated",
  "expiresAt",
  "workosSessionId",
  "workosAccessToken",
  "version",
]);
export const ORG_MEMBERSHIP_KEYS = new Set([
  "orgId",
  "orgSlug",
  "orgRole",
  "isProvisional",
  "demoExpiresAt",
  "apps",
]);
export const APP_MEMBERSHIP_KEYS = new Set(["appId", "appSlug", "role"]);
const LEGACY_ORG_MEMBERSHIP_KEYS = new Set(["orgId", "orgSlug", "orgRole", "apps"]);

export function parseStoredSession(
  raw: string,
  now: number,
): { ok: true; session: StoredSession } | { ok: false; reason: "expired" | "invalid" } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "invalid" };
  }

  if (!isPlainObject(parsed) || !hasOnlyKeys(parsed, STORED_SESSION_KEYS)) {
    return { ok: false, reason: "invalid" };
  }

  const session = normalizeStoredSession(parsed);
  if (!session) {
    return { ok: false, reason: "invalid" };
  }
  if (session.expiresAt <= nowSeconds(now)) {
    return { ok: false, reason: "expired" };
  }

  return { ok: true, session };
}

function normalizeStoredSession(value: Record<string, unknown>): StoredSession | null {
  const candidate = value as Partial<StoredSession>;
  if (candidate.version === undefined && isLegacyStoredSession(candidate)) {
    return {
      ...candidate,
      version: 1,
      orgs: candidate.orgs.map((org) => ({
        ...org,
        isProvisional: false,
        demoExpiresAt: null,
      })),
    } as StoredSession;
  }
  return isStoredSession(candidate) ? candidate : null;
}

function isStoredSession(value: Partial<StoredSession>): value is StoredSession {
  return (
    isNonEmptyString(value.userId) &&
    Number.isInteger(value.expiresAt) &&
    (value.version === 1 || value.version === 2) &&
    (value.workosSessionId === undefined || isNonEmptyString(value.workosSessionId)) &&
    (value.workosAccessToken === undefined || isNonEmptyString(value.workosAccessToken)) &&
    (value.orgsTruncated === undefined || typeof value.orgsTruncated === "boolean") &&
    Array.isArray(value.orgs) &&
    value.orgs.every(isOrgMembership)
  );
}

function isLegacyStoredSession(
  value: Partial<StoredSession>,
): value is Omit<StoredSession, "version"> {
  return (
    isNonEmptyString(value.userId) &&
    Number.isInteger(value.expiresAt) &&
    (value.workosSessionId === undefined || isNonEmptyString(value.workosSessionId)) &&
    (value.workosAccessToken === undefined || isNonEmptyString(value.workosAccessToken)) &&
    // Checked here too, not only on the v2 path: the key allowlist admits it and
    // `normalizeStoredSession` spreads the candidate through, so without this a
    // v1 session carrying `orgsTruncated: "definitely"` would load with the
    // string intact while the identical v2 session is rejected.
    (value.orgsTruncated === undefined || typeof value.orgsTruncated === "boolean") &&
    Array.isArray(value.orgs) &&
    value.orgs.every(isLegacyOrgMembership)
  );
}

function isLegacyOrgMembership(
  value: unknown,
): value is Omit<OrgMembership, "isProvisional" | "demoExpiresAt"> {
  if (!isPlainObject(value) || !hasOnlyKeys(value, LEGACY_ORG_MEMBERSHIP_KEYS)) {
    return false;
  }
  const candidate = value as Partial<OrgMembership>;
  return (
    isNonEmptyString(candidate.orgId) &&
    isNonEmptyString(candidate.orgSlug) &&
    typeof candidate.orgRole === "string" &&
    ORG_ROLES.has(candidate.orgRole) &&
    Array.isArray(candidate.apps) &&
    candidate.apps.every(isAppMembership)
  );
}

function isOrgMembership(value: unknown): value is OrgMembership {
  if (!isPlainObject(value) || !hasOnlyKeys(value, ORG_MEMBERSHIP_KEYS)) {
    return false;
  }
  const candidate = value as Partial<OrgMembership>;
  return (
    isNonEmptyString(candidate.orgId) &&
    isNonEmptyString(candidate.orgSlug) &&
    typeof candidate.orgRole === "string" &&
    ORG_ROLES.has(candidate.orgRole) &&
    typeof candidate.isProvisional === "boolean" &&
    (candidate.demoExpiresAt === null || isNonEmptyString(candidate.demoExpiresAt)) &&
    Array.isArray(candidate.apps) &&
    candidate.apps.every(isAppMembership)
  );
}

function isAppMembership(value: unknown): value is AppMembership {
  if (!isPlainObject(value) || !hasOnlyKeys(value, APP_MEMBERSHIP_KEYS)) {
    return false;
  }
  const candidate = value as Partial<AppMembership>;
  return (
    isNonEmptyString(candidate.appId) &&
    isNonEmptyString(candidate.appSlug) &&
    typeof candidate.role === "string" &&
    APP_ROLES.has(candidate.role)
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowedKeys: Set<string>): boolean {
  return Object.keys(value).every((key) => allowedKeys.has(key));
}
