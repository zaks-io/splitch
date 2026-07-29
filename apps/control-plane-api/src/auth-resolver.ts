import type { AuthDoor } from "@splitch/contracts";
import {
  CONTROL_PANEL_DELEGATION_HEADER,
  verifyControlPanelDelegation,
} from "@splitch/control-plane-sdk/control-panel-identity";
import type { AuthResolver } from "@splitch/worker-runtime";
import { parseControlPanelBindingOperation } from "./control-panel-operation";
import type { JwksVerifier } from "./jwks-verify";
import type { PanelDelegationReplayStore } from "./panel-identity-replay";
import type { PanelSessionAccess } from "./panel-session-access";
import { deriveBinding } from "./scope-binding";
import type { PanelSessionStore, SessionStore } from "./session-store";

/**
 * Control-plane auth resolver (the `control-plane-token` AuthKind).
 *
 * Normal callers use bearer JWTs. The binding-only Control Panel entrypoint may
 * instead redeem a short-lived, authenticated, single-use delegation. The reusable
 * panel session remains inside the Control Panel Worker.
 * Binding calls verify the signature, allowlisted operation and resource claims,
 * canonical request-body digest, expiry, and single-use nonce before deriving
 * authority from live D1 access.
 * During the self-expiring deploy bridge only, the predecessor entrypoint may
 * redeem the old Panel's SHA-256 session handle for apps_create. That path
 * resolves the live session from KV and still rechecks the Org role in D1.
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

/**
 * A Control Panel session is only ever minted after a completed WorkOS sign-in
 * (`completeAuthKitCallback`), which is the `id_jag` door. So this is a fact
 * about the path, not a default.
 *
 * Note this says nothing about whether the session's ORG is provisional — a
 * signed-in User can be looking at an unclaimed Organization, and the session
 * carries `isProvisional` for exactly that case. The door records how the
 * PRINCIPAL authenticated, which is what the provisional gates key on.
 */
const PANEL_AUTH_DOOR: AuthDoor = "id_jag";

export interface ControlPlaneAuthDeps {
  verifier: JwksVerifier;
  sessions: SessionStore;
  /** Clock seam (seconds since epoch); defaults to wall clock. */
  now?: () => number;
}

export interface ControlPlaneAuthOptions {
  /** Only the named Control Panel Worker entrypoint may redeem panel delegations. */
  allowPanelDelegation?: boolean;
  panelDelegationSecret?: string;
  panelAccess?: PanelSessionAccess;
  panelDelegationReplay?: PanelDelegationReplayStore;
  /** Temporary predecessor bridge. The deployment workflow disables it after V2 is live. */
  allowBoundedPanelSession?: boolean;
  boundedPanelSessions?: PanelSessionStore;
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
    if (
      (options.allowPanelDelegation || options.allowBoundedPanelSession) &&
      request.headers.get("authorization") === null
    ) {
      const panelPrincipal = await resolvePanelPrincipal(
        request,
        nowSeconds(),
        options.boundedPanelSessions,
        options.panelDelegationSecret,
        options.panelAccess,
        options.panelDelegationReplay,
        options.allowBoundedPanelSession ?? false,
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
      authDoor: verified.authDoor,
    },
  };
}

async function resolvePanelPrincipal(
  request: Request,
  nowSeconds: number,
  boundedPanelSessions?: PanelSessionStore,
  delegationSecret?: string,
  panelAccess?: PanelSessionAccess,
  replay?: PanelDelegationReplayStore,
  allowBoundedPanelSession = false,
) {
  const operation = parseControlPanelBindingOperation(request);
  if (!operation) return null;

  if (allowBoundedPanelSession) {
    if (!boundedPanelSessions) return null;
    return resolveBoundedPanelSessionPrincipal(
      request,
      operation,
      boundedPanelSessions,
      nowSeconds,
    );
  }

  const delegation = delegationSecret
    ? await verifyControlPanelDelegation(
        request.headers.get(CONTROL_PANEL_DELEGATION_HEADER),
        request,
        operation,
        delegationSecret,
        nowSeconds,
      )
    : null;
  if (
    !delegation ||
    !replay ||
    !(await replay.consume(delegation.nonce, delegation.expiresAt, nowSeconds))
  ) {
    return null;
  }
  if (operation.id === "apps_create") {
    return {
      ok: true as const,
      principal: {
        kind: "control-plane-token" as const,
        id: delegation.actorId,
        // This ceiling scope binds the delegated path; the handler still rechecks
        // the actor's live owner/admin role in D1 before creating the App.
        scopes: [`org:${operation.orgId}:owner`],
        orgId: operation.orgId,
        appId: null,
        environmentId: null,
        authDoor: PANEL_AUTH_DOOR,
      },
    };
  }
  if (operation.id === "experiments_list") {
    return {
      ok: true as const,
      principal: {
        kind: "control-plane-token" as const,
        id: delegation.actorId,
        scopes: [],
        orgId: null,
        appId: null,
        environmentId: null,
        authDoor: PANEL_AUTH_DOOR,
      },
    };
  }

  return resolvePanelFlagsPrincipal(operation, delegation.actorId, panelAccess);
}

async function resolveBoundedPanelSessionPrincipal(
  request: Request,
  operation: NonNullable<ReturnType<typeof parseControlPanelBindingOperation>>,
  sessions: PanelSessionStore,
  nowSeconds: number,
) {
  if (operation.id !== "apps_create") return null;
  const tokenHash = request.headers.get(PANEL_SESSION_HEADER);
  if (!tokenHash) return null;
  const actor = await sessions.loadPanelSessionActor(tokenHash, nowSeconds);
  if (!actor) return null;
  return {
    ok: true as const,
    principal: {
      kind: "control-plane-token" as const,
      id: actor.userId,
      // Cached panel roles never authorize the mutation. This ceiling scope binds
      // the path while the apps_create handler still requires the live D1 role.
      scopes: [`org:${operation.orgId}:owner`],
      orgId: operation.orgId,
      appId: null,
      environmentId: null,
      authDoor: PANEL_AUTH_DOOR,
    },
  };
}

async function resolvePanelFlagsPrincipal(
  operation: Exclude<
    ReturnType<typeof parseControlPanelBindingOperation>,
    { id: "apps_create" | "experiments_list" } | null
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
      authDoor: PANEL_AUTH_DOOR,
    },
  };
}
