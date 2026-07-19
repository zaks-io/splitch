import type { AuthResolver } from "@splitch/worker-runtime";
import {
  CONTROL_PANEL_IDENTITY_HEADER,
  parseControlPanelIdentity,
  verifyControlPanelIdentity,
} from "@splitch/control-plane-sdk/control-panel-identity";
import { parseControlPanelBindingOperation } from "./control-panel-operation";
import type { JwksVerifier } from "./jwks-verify";
import type { PanelIdentityReplayStore } from "./panel-identity-replay";
import type { PanelSessionAccess } from "./panel-session-access";
import { deriveBinding } from "./scope-binding";
import type { SessionStore } from "./session-store";

/**
 * Control-plane auth resolver (the `control-plane-token` AuthKind).
 *
 * Normal callers use bearer JWTs. The binding-only Control Panel entrypoint may
 * instead redeem a short-lived, single-use downstream identity. The reusable
 * panel session remains inside the Control Panel Worker.
 * Binding calls verify the allowlisted operation and resource claims, expiry,
 * and single-use nonce before deriving authority from live D1 access.
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

export interface ControlPlaneAuthOptions {
  /** Only the named Control Panel Worker entrypoint may redeem panel identities. */
  allowPanelIdentity?: boolean;
  panelAccess?: PanelSessionAccess;
  panelIdentityReplay?: PanelIdentityReplayStore;
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
    if (options.allowPanelIdentity && request.headers.get("authorization") === null) {
      const panelPrincipal = await resolvePanelPrincipal(
        request,
        nowSeconds(),
        options.panelAccess,
        options.panelIdentityReplay,
      );
      if (panelPrincipal) return panelPrincipal;
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

async function resolvePanelPrincipal(
  request: Request,
  nowSeconds: number,
  panelAccess?: PanelSessionAccess,
  replay?: PanelIdentityReplayStore,
) {
  const operation = parseControlPanelBindingOperation(request);
  const identity = parseControlPanelIdentity(request.headers.get(CONTROL_PANEL_IDENTITY_HEADER));
  if (
    !operation ||
    !identity ||
    !replay ||
    !verifyControlPanelIdentity(identity, operation, nowSeconds) ||
    !(await replay.consume(identity.nonce, identity.expiresAt, nowSeconds))
  ) {
    return null;
  }
  if (operation.id === "apps_create") {
    return {
      ok: true as const,
      principal: {
        kind: "control-plane-token" as const,
        id: identity.actorId,
        // The apps_create handler rechecks the live owner/admin role in D1.
        scopes: [`org:${operation.orgId}:member`],
        orgId: operation.orgId,
        appId: null,
        environmentId: null,
      },
    };
  }

  return resolvePanelFlagsPrincipal(operation, identity.actorId, panelAccess);
}

async function resolvePanelFlagsPrincipal(
  operation: Exclude<
    ReturnType<typeof parseControlPanelBindingOperation>,
    { id: "apps_create" } | null
  >,
  actorId: string,
  panelAccess?: PanelSessionAccess,
) {
  if (!panelAccess) return null;
  const access = await panelAccess.authorizeApp(actorId, operation.appId, operation.environmentId);
  if (!access) {
    return {
      ok: false as const,
      reason: "UNAUTHORIZED" as const,
      error: {
        code: "FORBIDDEN" as const,
        message: "live App membership and resource access are required",
        details: {},
      },
    };
  }

  return {
    ok: true as const,
    principal: {
      kind: "control-plane-token" as const,
      id: actorId,
      scopes: [`org:${access.orgId}:${access.orgRole}`, `app:${access.appId}:${access.appRole}`],
      orgId: access.orgId,
      appId: access.appId,
      environmentId: null,
    },
  };
}
