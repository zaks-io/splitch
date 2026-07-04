import type { AuthResolver } from "@splitch/worker-runtime";
import { deriveBinding } from "./scope-binding";
import type { JwksVerifier } from "./jwks-verify";
import type { SessionStore } from "./session-store";

/**
 * Control-plane bearer-JWT auth resolver (the `control-plane-token` AuthKind).
 *
 * Order (access-control-matrix.md "Token validation"):
 *   1. Extract `Authorization: Bearer <jwt>`; absent/malformed → UNAUTHORIZED.
 *   2. Verify signature (JWKS) + `aud` + `exp` via the JwksVerifier; fail →
 *      UNAUTHORIZED. (The verifier returns null for every bad-token case and only
 *      throws on a genuine fault, e.g. JWKS unreachable, which the guard maps to
 *      500 — never a silent allow.)
 *   3. Session-validation hot read: a revoked session → CREDENTIAL_REVOKED. A KV
 *      fault throws (guard → 500), never a silent pass.
 *   4. Success → Principal: scopes pass through from the token, `id` = `sub`
 *      (audit/user_id), Org/App/Env binding derived from the scopes.
 *
 * The resolver returns typed failures (it does NOT throw for the ordinary
 * unauthenticated/revoked cases); the registrar renders them through the shared
 * ErrorResponse. Scope matching + Org/App/Env co-scope are the registrar's job
 * (steps/scopes.ts); this resolver only produces the Principal it feeds them.
 */

const BEARER_PREFIX = "Bearer ";

export interface ControlPlaneAuthDeps {
  verifier: JwksVerifier;
  sessions: SessionStore;
  /** Clock seam (seconds since epoch); defaults to wall clock. */
  now?: () => number;
}

function extractBearer(header: string | null): string | null {
  if (!header?.startsWith(BEARER_PREFIX)) {
    return null;
  }
  const token = header.slice(BEARER_PREFIX.length).trim();
  return token.length > 0 ? token : null;
}

export function makeControlPlaneAuthResolver(deps: ControlPlaneAuthDeps): AuthResolver {
  const nowSeconds = () => Math.floor((deps.now?.() ?? Date.now()) / 1000);

  return async (request) => {
    const token = extractBearer(request.headers.get("authorization"));
    if (!token) {
      return { ok: false, reason: "UNAUTHORIZED" };
    }

    const verified = await deps.verifier.verify(token, nowSeconds());
    if (!verified) {
      return { ok: false, reason: "UNAUTHORIZED" };
    }

    // Session-validation hot read keyed on the actor's session (`sub`). A
    // revoked session is rejected even though the signature/exp still pass.
    if (await deps.sessions.isRevoked(verified.sub)) {
      return { ok: false, reason: "CREDENTIAL_REVOKED" };
    }

    const binding = deriveBinding(verified.scopes);
    return {
      ok: true,
      principal: {
        kind: "control-plane-token",
        id: verified.sub,
        scopes: verified.scopes,
        orgId: binding.orgId,
        appId: binding.appId,
        environmentId: binding.environmentId,
      },
    };
  };
}
