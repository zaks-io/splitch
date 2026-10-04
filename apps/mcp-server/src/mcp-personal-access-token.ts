import {
  isPersonalAccessTokenSecret,
  PERSONAL_ACCESS_TOKEN_SECRET_PREFIX,
  PersonalAccessTokenCacheSchema,
  personalAccessTokenCacheKey,
  personalAccessTokenExpired,
} from "@splitch/contracts";
import type { McpAccessTokenActor } from "./mcp-access-token";

/**
 * Personal Access Token authentication for the MCP Worker (ADR-0022,
 * 2026-10-03 amendment). The Worker has no D1, so it authenticates the secret
 * against the SESSION_STORE entry the Control Plane writes on create, rotate,
 * update, and revoke. That entry only names the owner and token id: authority
 * is never decided here. Every delegated operation carries the token id, and
 * the Control Plane re-reads the D1 row and clamps live membership by its
 * current grants, so revocation is enforced there even before KV converges.
 */

export type PersonalAccessTokenVerification =
  | { ok: true; actor: McpAccessTokenActor }
  | { ok: false; description: string };

export function looksLikePersonalAccessToken(authorization: string): boolean {
  return authorization.startsWith(`Bearer ${PERSONAL_ACCESS_TOKEN_SECRET_PREFIX}`);
}

export async function verifyPersonalAccessToken(
  store: Pick<KVNamespace, "get">,
  authorization: string,
  nowMs: number,
): Promise<PersonalAccessTokenVerification> {
  const secret = authorization.slice("Bearer ".length).trim();
  if (!isPersonalAccessTokenSecret(secret)) {
    return refused("personal access token is malformed");
  }
  const hash = await sha256Hex(secret);
  const raw = await store.get(personalAccessTokenCacheKey(hash));
  if (raw === null) {
    return refused("personal access token is unknown; create one with `splitch tokens create`");
  }
  const entry = PersonalAccessTokenCacheSchema.safeParse(JSON.parse(raw));
  if (!entry.success) {
    throw new Error("mcp-server: personal access token cache entry is malformed");
  }
  if (entry.data.revoked) {
    return refused("personal access token was revoked or rotated; use its replacement");
  }
  if (personalAccessTokenExpired(entry.data.expiresAt, nowMs)) {
    return refused("personal access token has expired; rotate or create a new one");
  }
  return {
    ok: true,
    actor: {
      subject: entry.data.userId,
      scopes: [],
      liveMembership: true,
      authDoor: "personal_access_token",
      personalAccessTokenId: entry.data.tokenId,
      personalAccessTokenHash: hash,
    },
  };
}

function refused(description: string): PersonalAccessTokenVerification {
  return { ok: false, description };
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
