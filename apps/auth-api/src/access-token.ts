/**
 * Control-plane access-token verification for the trusted-IdP CRUD surface.
 *
 * The CRUD endpoints are authenticated management mutations: the caller presents
 * the Bearer access token minted by /oauth2/token. We verify its HMAC signature
 * (with the ACCESS secret — distinct from the assertion secret), then assert it
 * is genuinely an access token bound to the control-plane audience, before
 * handing the `sub` (WorkOS user_id) to the CRUD layer, which does the real
 * Org-owner authorization against D1. The token scope is audit context, not the
 * authz decision (ADR-0022).
 *
 * Type-confusion guard: an identity_assertion (whose scopes are attacker-
 * influenced via requested_scopes) must NEVER pass as a Bearer. Three independent
 * defenses: (1) the access secret differs from the assertion secret, so the
 * signature check itself fails; (2) `typ` must equal "access_token"; (3) `aud`
 * must equal the control-plane audience.
 */

export interface VerifiedActor {
  userId: string;
  scopes: string[];
  expiresAt: number;
}

function base64UrlToBytes(input: string): Uint8Array {
  const padded = input
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(input.length / 4) * 4, "=");
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret) as unknown as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
}

/** Verify a Bearer access token; return the actor, or null on any failure (fail-closed). */
export async function verifyAccessToken(
  authorizationHeader: string | null,
  opts: { accessSecret: string; controlPlaneAudience: string },
  nowSeconds: number,
): Promise<VerifiedActor | null> {
  if (!authorizationHeader?.startsWith("Bearer ")) {
    return null;
  }
  const token = authorizationHeader.slice("Bearer ".length).trim();
  const parts = token.split(".");
  if (parts.length !== 3) {
    return null;
  }
  const [h, p, s] = parts as [string, string, string];
  const ok = await crypto.subtle.verify(
    "HMAC",
    await hmacKey(opts.accessSecret),
    base64UrlToBytes(s) as unknown as BufferSource,
    new TextEncoder().encode(`${h}.${p}`) as unknown as BufferSource,
  );
  if (!ok) {
    return null;
  }
  const claims = JSON.parse(new TextDecoder().decode(base64UrlToBytes(p))) as Record<
    string,
    unknown
  >;
  // Must be a genuine access token, not an identity_assertion replayed as a Bearer.
  if (claims.typ !== "access_token" || typeof claims.sub !== "string") {
    return null;
  }
  // aud must bind to the control-plane resource this Worker mints for.
  if (claims.aud !== opts.controlPlaneAudience) {
    return null;
  }
  // exp is REQUIRED: a missing exp must not be read as never-expires (fail-loud).
  if (typeof claims.exp !== "number" || claims.exp < nowSeconds) {
    return null;
  }
  return {
    userId: claims.sub,
    scopes: Array.isArray(claims.scopes) ? (claims.scopes as string[]) : [],
    expiresAt: claims.exp,
  };
}
