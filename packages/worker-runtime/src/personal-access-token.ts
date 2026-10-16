import {
  isPersonalAccessTokenSecret,
  type McpDelegationActor,
  PersonalAccessTokenCacheSchema,
  personalAccessTokenCacheKey,
  personalAccessTokenExpired,
} from "@splitch/contracts";

export type PersonalAccessTokenVerification =
  | { ok: true; actor: McpDelegationActor & { scopes: string[] } }
  | { ok: false; description: string };

/** KV is only a fast reject. Every accepted operation must resolve D1 authority below. */
export async function verifyPersonalAccessTokenSecret(
  store: Pick<KVNamespace, "get">,
  secret: string,
  nowMs: number,
): Promise<PersonalAccessTokenVerification> {
  if (!isPersonalAccessTokenSecret(secret)) {
    return { ok: false, description: "personal access token is malformed" };
  }
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  const hash = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  const raw = await store.get(personalAccessTokenCacheKey(hash));
  if (raw === null) {
    return {
      ok: false,
      description: "personal access token is unknown; create one with `splitch tokens create`",
    };
  }
  const entry = PersonalAccessTokenCacheSchema.safeParse(JSON.parse(raw));
  if (!entry.success) throw new Error("personal access token cache entry is malformed");
  if (entry.data.revoked) {
    return {
      ok: false,
      description: "personal access token was revoked or rotated; use its replacement",
    };
  }
  if (personalAccessTokenExpired(entry.data.expiresAt, nowMs)) {
    return {
      ok: false,
      description: "personal access token has expired; rotate or create a new one",
    };
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
