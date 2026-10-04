import { z } from "@hono/zod-openapi";
import { type UserRole, UserRoleSchema } from "./leaf-schemas-runtime";

/**
 * Personal Access Tokens: long-lived, user-bound, revocable bearer credentials
 * accepted ONLY by the remote MCP server (ADR-0022, 2026-10-03 amendment).
 *
 * A PAT is never a separate principal. Its authority is the owning user's LIVE
 * Organization/App membership, clamped by the token's own grants on every
 * request. The secret is surfaced once, at create or rotate; storage holds only
 * its SHA-256 hash.
 */

export const PERSONAL_ACCESS_TOKEN_SECRET_PREFIX = "spl_pat_";
export const PERSONAL_ACCESS_TOKEN_SECRET_PATTERN = /^spl_pat_[0-9a-f]{64}$/;
export const PERSONAL_ACCESS_TOKEN_ID_PATTERN = /^pat_[0-9a-f]{32}$/;
export const PERSONAL_ACCESS_TOKEN_DEFAULT_TTL_DAYS = 90;
export const PERSONAL_ACCESS_TOKEN_MAX_GRANTS = 32;
/** Active (unrevoked) tokens one user may hold at once. */
export const PERSONAL_ACCESS_TOKEN_MAX_ACTIVE = 50;
/** Hex characters of the stored hash shown as a non-secret fingerprint. */
export const PERSONAL_ACCESS_TOKEN_FINGERPRINT_LENGTH = 12;

// Canonical ids only: a slug or App key could be re-pointed by renaming, so a
// grant always names the stable id it was validated against.
const GRANT_TARGET_PATTERN = /^(all|org:org_[A-Za-z0-9_-]{1,124}|app:app_[A-Za-z0-9_-]{1,124})$/;

export const personalAccessTokenAccessLevels = ["read", "read-write"] as const;
export const PersonalAccessTokenAccessSchema = z.enum(personalAccessTokenAccessLevels);
export type PersonalAccessTokenAccess = z.infer<typeof PersonalAccessTokenAccessSchema>;

export const PersonalAccessTokenIdSchema = z
  .string()
  .regex(PERSONAL_ACCESS_TOKEN_ID_PATTERN, "expected a Personal Access Token id (pat_…)");

/**
 * One grant. `target` is `all` (every current and future membership), `org:<id>`
 * (that Organization and every App in it), or `app:<id>`. `role` is a ceiling:
 * the effective role is never above the user's live role. `access: "read"`
 * refuses every mutating operation on that target.
 */
export const PersonalAccessTokenGrantSchema = z
  .object({
    target: z
      .string()
      .regex(
        GRANT_TARGET_PATTERN,
        "expected `all`, `org:org_…`, or `app:app_…` (canonical ids, not slugs)",
      ),
    role: UserRoleSchema,
    access: PersonalAccessTokenAccessSchema,
  })
  .strict();
export type PersonalAccessTokenGrant = z.infer<typeof PersonalAccessTokenGrantSchema>;

export const PersonalAccessTokenGrantsSchema = z
  .array(PersonalAccessTokenGrantSchema)
  .min(1)
  .max(PERSONAL_ACCESS_TOKEN_MAX_GRANTS);

const PersonalAccessTokenNameSchema = z.string().trim().min(1).max(64);

const personalAccessTokenStatuses = ["active", "expired", "revoked"] as const;

export const PersonalAccessTokenSchema = z
  .object({
    id: PersonalAccessTokenIdSchema,
    name: z.string(),
    grants: z.array(PersonalAccessTokenGrantSchema),
    /** `null` means the token never expires; `neverExpires` states it explicitly. */
    expiresAt: z.string().nullable(),
    neverExpires: z.boolean(),
    status: z.enum(personalAccessTokenStatuses),
    /** Leading hex of the stored hash; identifies a token without its secret. */
    fingerprint: z.string(),
    createdAt: z.string(),
    lastRotatedAt: z.string().nullable(),
    revokedAt: z.string().nullable(),
  })
  .strict();
export type PersonalAccessToken = z.infer<typeof PersonalAccessTokenSchema>;

/**
 * `expiresAt` omitted = the default TTL; `null` = never expires (an explicit
 * choice, never a default); otherwise an ISO 8601 instant in the future.
 */
const ExpiresAtInputSchema = z.string().datetime({ offset: true }).nullable();

export const CreatePersonalAccessTokenRequestSchema = z
  .object({
    name: PersonalAccessTokenNameSchema,
    grants: PersonalAccessTokenGrantsSchema,
    expiresAt: ExpiresAtInputSchema.optional(),
  })
  .strict();

export const UpdatePersonalAccessTokenRequestSchema = z
  .object({
    name: PersonalAccessTokenNameSchema.optional(),
    grants: PersonalAccessTokenGrantsSchema.optional(),
    expiresAt: ExpiresAtInputSchema.optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, {
    message: "provide at least one of name, grants, expiresAt",
  });

/** The only response that ever carries the secret (create and rotate). */
export const PersonalAccessTokenSecretResponseSchema = z
  .object({
    token: PersonalAccessTokenSchema,
    secret: z.string().regex(PERSONAL_ACCESS_TOKEN_SECRET_PATTERN),
  })
  .strict();

export const RevokeAllPersonalAccessTokensResponseSchema = z
  .object({ revokedCount: z.number().int().nonnegative() })
  .strict();

/**
 * SESSION_STORE entry the MCP Worker reads to authenticate a PAT before any
 * tool call. D1 stays authoritative: the Control Plane re-reads the row on
 * every delegated operation, so a stale KV entry never widens authority.
 */
export const PersonalAccessTokenCacheSchema = z
  .object({
    version: z.literal(1),
    tokenId: PersonalAccessTokenIdSchema,
    userId: z.string().min(1).max(256),
    createdAt: z.string(),
    expiresAt: z.string().nullable(),
    revoked: z.boolean(),
  })
  .strict();
export type PersonalAccessTokenCache = z.infer<typeof PersonalAccessTokenCacheSchema>;

/** `pat:{sha256Hex(secret)}` in SESSION_STORE. */
export function personalAccessTokenCacheKey(secretHashHex: string): string {
  return `pat:${secretHashHex}`;
}

export function isPersonalAccessTokenSecret(value: string): boolean {
  return PERSONAL_ACCESS_TOKEN_SECRET_PATTERN.test(value);
}

export function personalAccessTokenExpired(expiresAt: string | null, nowMs: number): boolean {
  if (expiresAt === null) return false;
  const expiresMs = Date.parse(expiresAt);
  // An unparseable stored expiry is a corrupted row: treat it as expired.
  return !Number.isFinite(expiresMs) || expiresMs <= nowMs;
}

interface ClampMemberships {
  organizations: readonly { id: string; role: UserRole }[];
  apps: readonly { id: string; organizationId: string; role: UserRole }[];
}

/**
 * The authority a PAT holds right now. `scopes` drive reads; on a mutating
 * operation the principal is narrowed to `writeScopes`, and a mutation with no
 * Organization or App in its path additionally requires `writeAll`.
 */
export interface PersonalAccessTokenAuthority {
  scopes: string[];
  writeScopes: string[];
  writeAll: boolean;
}

const ROLE_RANK: Record<UserRole, number> = { member: 1, admin: 2, owner: 3 };

/**
 * Intersect live membership with grants. A grant never adds a membership the
 * user does not hold, and the effective role is min(live role, best applicable
 * grant ceiling). An Organization grant covers the Organization and its Apps;
 * an App grant covers that App only.
 */
export function personalAccessTokenAuthority(
  memberships: ClampMemberships,
  grants: readonly PersonalAccessTokenGrant[],
): PersonalAccessTokenAuthority {
  const writable = grants.filter((grant) => grant.access === "read-write");
  return {
    scopes: clampedScopes(memberships, grants),
    writeScopes: clampedScopes(memberships, writable),
    writeAll: writable.some((grant) => grant.target === "all"),
  };
}

function clampedScopes(
  memberships: ClampMemberships,
  grants: readonly PersonalAccessTokenGrant[],
): string[] {
  const scopes: string[] = [];
  for (const org of memberships.organizations) {
    const role = clampRole(org.role, grants, ["all", `org:${org.id}`]);
    if (role) scopes.push(`org:${org.id}:${role}`);
  }
  for (const app of memberships.apps) {
    const role = clampRole(app.role, grants, ["all", `org:${app.organizationId}`, `app:${app.id}`]);
    if (role) scopes.push(`app:${app.id}:${role}`);
  }
  return scopes.sort();
}

function clampRole(
  liveRole: UserRole,
  grants: readonly PersonalAccessTokenGrant[],
  targets: readonly string[],
): UserRole | null {
  let ceiling: UserRole | null = null;
  for (const grant of grants) {
    if (!targets.includes(grant.target)) continue;
    if (ceiling === null || ROLE_RANK[grant.role] > ROLE_RANK[ceiling]) ceiling = grant.role;
  }
  if (ceiling === null) return null;
  return ROLE_RANK[ceiling] < ROLE_RANK[liveRole] ? ceiling : liveRole;
}

/** True when `role` is at or above `required`. */
export function userRoleCovers(role: UserRole, required: UserRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[required];
}
