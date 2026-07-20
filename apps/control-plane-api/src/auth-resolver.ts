import type { AuthResolver } from "@splitch/worker-runtime";
import type { JwksVerifier } from "./jwks-verify";
import { deriveBinding } from "./scope-binding";
import type { SessionStore } from "./session-store";

/**
 * Control-plane auth resolver (the `control-plane-token` AuthKind).
 *
 * Normal callers use bearer JWTs. The Control Panel may instead present the
 * SHA-256 handle of its already-validated server session, but only for the
 * `apps_create` route over the Worker service binding. The Control Plane
 * resolves that handle from shared session KV and still performs live D1 role
 * authorization in the route handler.
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
export const PANEL_SESSION_HEADER = "x-splitch-panel-session";
const APPS_CREATE_PATH = /^\/orgs\/([^/]+)\/apps\/?$/;

export interface ControlPlaneAuthDeps {
  verifier: JwksVerifier;
  sessions: SessionStore;
  /** Clock seam (seconds since epoch); defaults to wall clock. */
  now?: () => number;
}

export interface ControlPlaneAuthOptions {
  /** Only the named Control Panel Worker entrypoint may redeem panel sessions. */
  allowPanelSession?: boolean;
}

function extractBearer(header: string | null): string | null {
  if (!header?.startsWith(BEARER_PREFIX)) {
    return null;
  }
  const token = header.slice(BEARER_PREFIX.length).trim();
  return token.length > 0 ? token : null;
}

export function makeControlPlaneAuthResolver(
  deps: ControlPlaneAuthDeps,
  options: ControlPlaneAuthOptions = {},
): AuthResolver {
  const nowSeconds = () => Math.floor((deps.now?.() ?? Date.now()) / 1000);

  return async (request) => {
    if (options.allowPanelSession && request.headers.get("authorization") === null) {
      const panelPrincipal = await resolvePanelAppsCreatePrincipal(
        request,
        deps.sessions,
        nowSeconds(),
      );
      if (panelPrincipal) {
        return { ok: true, principal: panelPrincipal };
      }
    }
    return resolveBearerPrincipal(request, deps, nowSeconds());
  };
}

async function resolveBearerPrincipal(
  request: Request,
  deps: ControlPlaneAuthDeps,
  nowSeconds: number,
) {
  const token = extractBearer(request.headers.get("authorization"));
  if (!token) {
    return { ok: false as const, reason: "UNAUTHORIZED" as const };
  }

  const verified = await deps.verifier.verify(token, nowSeconds);
  if (!verified) {
    return { ok: false as const, reason: "UNAUTHORIZED" as const };
  }

  // Session-validation hot read keyed on the actor's session (`sub`). A
  // revoked session is rejected even though the signature/exp still pass.
  if (await deps.sessions.isRevoked(verified.sub)) {
    return { ok: false as const, reason: "CREDENTIAL_REVOKED" as const };
  }

  const binding = deriveBinding(verified.scopes);
  return {
    ok: true as const,
    principal: {
      kind: "control-plane-token" as const,
      id: verified.sub,
      scopes: verified.scopes,
      orgId: binding.orgId,
      appId: binding.appId,
      environmentId: binding.environmentId,
    },
  };
}

async function resolvePanelAppsCreatePrincipal(
  request: Request,
  sessions: SessionStore,
  nowSeconds: number,
) {
  if (request.method !== "POST") {
    return null;
  }
  const match = new URL(request.url).pathname.match(APPS_CREATE_PATH);
  const encodedOrgId = match?.[1];
  const tokenHash = request.headers.get(PANEL_SESSION_HEADER);
  if (!encodedOrgId || !tokenHash) {
    return null;
  }
  const actor = await sessions.loadPanelSessionActor(tokenHash, nowSeconds);
  if (!actor) {
    return null;
  }
  const orgId = decodePathSegment(encodedOrgId);
  if (!orgId) {
    return null;
  }
  return {
    kind: "control-plane-token" as const,
    id: actor.userId,
    // Cached panel roles never authorize the mutation. This ceiling scope binds
    // the path while the apps_create handler still requires the live D1 role.
    scopes: [`org:${orgId}:owner`],
    orgId,
    appId: null,
    environmentId: null,
  };
}

function decodePathSegment(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}
