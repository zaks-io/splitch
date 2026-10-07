import {
  PERSONAL_ACCESS_TOKEN_FINGERPRINT_LENGTH,
  type PersonalAccessToken,
  type PersonalAccessTokenCache,
  type PersonalAccessTokenGrant,
  PersonalAccessTokenGrantsSchema,
  personalAccessTokenAuthority,
  personalAccessTokenCacheKey,
  personalAccessTokenExpired,
} from "@splitch/contracts";
import type { PersonalAccessTokenRow, Repository } from "@splitch/db";
import type { PersonalAccessTokenResolver } from "@splitch/worker-runtime";
import type { TokenMembershipAccess } from "./token-membership";

/** KV rejects an absolute expiration closer than 60 seconds. */
const MIN_KV_EXPIRATION_LEAD_SECONDS = 60;

/**
 * Write the SESSION_STORE entry the MCP Worker authenticates a PAT against.
 * Never best-effort: a failed write throws, so the caller fails loud rather
 * than reporting a create, rotate, or revoke the MCP door cannot see.
 *
 * The entry expires with the token. A revoked entry is a tombstone keyed by the
 * same hash, so a stale active entry can never outlive it.
 */
export async function writePersonalAccessTokenCache(
  store: KVNamespace,
  row: PersonalAccessTokenRow,
  tokenHash: string,
  revoked: boolean,
  nowMs: number,
): Promise<void> {
  const value: PersonalAccessTokenCache = {
    version: 1,
    tokenId: row.id,
    userId: row.userId,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    revoked,
  };
  await store.put(
    personalAccessTokenCacheKey(tokenHash),
    JSON.stringify(value),
    expirationOptions(row.expiresAt, nowMs),
  );
}

function expirationOptions(expiresAt: string | null, nowMs: number): KVNamespacePutOptions {
  if (expiresAt === null) return {};
  const floor = Math.ceil(nowMs / 1000) + MIN_KV_EXPIRATION_LEAD_SECONDS;
  return { expiration: Math.max(Math.ceil(Date.parse(expiresAt) / 1000), floor) };
}

function parseStoredGrants(row: Pick<PersonalAccessTokenRow, "grants" | "id">) {
  const parsed = PersonalAccessTokenGrantsSchema.safeParse(JSON.parse(row.grants));
  if (!parsed.success) {
    // A stored grant set that no longer parses is corrupt, not empty: refusing
    // the token beats guessing what it was allowed to do.
    throw new Error(`control-plane-api: personal access token ${row.id} has invalid grants`);
  }
  return parsed.data;
}

export function personalAccessTokenResponse(
  row: PersonalAccessTokenRow,
  nowMs: number,
): PersonalAccessToken {
  return {
    id: row.id,
    name: row.name,
    grants: parseStoredGrants(row),
    expiresAt: row.expiresAt,
    neverExpires: row.expiresAt === null,
    status: tokenStatus(row, nowMs),
    fingerprint: row.tokenHash.slice(0, PERSONAL_ACCESS_TOKEN_FINGERPRINT_LENGTH),
    createdAt: row.createdAt,
    lastRotatedAt: row.lastRotatedAt,
    revokedAt: row.revokedAt,
  };
}

function tokenStatus(row: PersonalAccessTokenRow, nowMs: number): PersonalAccessToken["status"] {
  if (row.revokedAt !== null) return "revoked";
  return personalAccessTokenExpired(row.expiresAt, nowMs) ? "expired" : "active";
}

/**
 * The MCP door's authority read. D1 is authoritative on every delegated call:
 * a revoked, expired, or re-owned row refuses even while a stale KV entry still
 * authenticates at the MCP Worker. Membership is read live and clamped by the
 * row's CURRENT grants, so a narrowed grant or a removed membership takes
 * effect on the next call without rotating the secret.
 */
export function makePersonalAccessTokenAuthorityResolver(deps: {
  repo: Pick<Repository, "personalAccessTokens">;
  membershipAccess: TokenMembershipAccess;
  nowMs: () => number;
}) {
  const resolve: PersonalAccessTokenResolver = async (token) => {
    const row = await deps.repo.personalAccessTokens.getById(token.tokenId);
    if (
      !row ||
      row.userId !== token.subject ||
      // Rotation is immediate: the presented secret must be the current one.
      row.tokenHash !== token.tokenHash ||
      row.revokedAt !== null ||
      personalAccessTokenExpired(row.expiresAt, deps.nowMs())
    ) {
      return null;
    }
    const grants: PersonalAccessTokenGrant[] = parseStoredGrants(row);
    return personalAccessTokenAuthority(await deps.membershipAccess.resolve(token.subject), grants);
  };
  return resolve;
}
