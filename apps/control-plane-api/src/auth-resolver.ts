import { type AuthDoor, MEMBERSHIP_WIDE_READ_AUTHORIZATION } from "@splitch/contracts";
import {
  CONTROL_PANEL_DELEGATION_HEADER,
  verifyControlPanelDelegation,
} from "@splitch/control-plane-sdk/control-panel-identity";
import type { AuthResolver } from "@splitch/worker-runtime";
import { parseControlPanelBindingOperation } from "./control-panel-operation";
import { type BearerAuthDeps, resolveBearerPrincipal } from "./bearer-principal";
import type { PanelDelegationReplayStore } from "./panel-identity-replay";
import type { PanelSessionAccess } from "./panel-session-access";
import type { PanelSessionStore } from "./session-store";

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
 *   2. Verify signature (JWKS) + `iss` + `typ` + `aud` + `exp`; fail →
 *      UNAUTHORIZED. (The verifier returns null for every bad-token case and only
 *      throws on a genuine fault, e.g. JWKS unreachable, which the guard maps to
 *      500 — never a silent allow.)
 *   3. Start the session-revocation and membership-set KV reads concurrently.
 *      A revoked session → CREDENTIAL_REVOKED. A revocation KV fault throws
 *      (guard → 500); a membership KV fault falls through to the complete D1
 *      resolve. Neither becomes a silent pass.
 *   4. Validate every Organization and App membership axis the token carries.
 *      A removed or role-incompatible membership is refused before route scope
 *      checks. Tokens with no membership axes (service credentials whose
 *      authority does not derive from membership) skip this read. A missing
 *      membership port or a thrown D1 membership read fails loud (guard → 500)
 *      and never produces a principal.
 *   5. For membership-wide read authority, require empty scopes and resolve the
 *      complete current Organization and App membership set.
 *   6. Success → Principal: `id` = `sub`; selector-bound Org/App/Environment
 *      axes derive from scopes, while wide principals carry live memberships.
 *
 * The resolver returns typed failures (it does NOT throw for the ordinary
 * unauthenticated/revoked cases); the registrar renders them through the shared
 * ErrorResponse. Scope matching + Org/App/Env co-scope are the registrar's job
 * (steps/scopes.ts); this resolver only produces the Principal it feeds them.
 */

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

export interface ControlPlaneAuthDeps extends BearerAuthDeps {
  /**
   * Live Org/App membership recheck for human/agent access tokens. Required on
   * every resolver. Tokens with no membership axes skip the read; a missing
   * port throws instead of minting a principal.
   */
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
  return resolveDelegatedPrincipal(operation, delegation.actorId, panelAccess);
}

/** Authority for a verified delegation, by what the operation names. */
async function resolveDelegatedPrincipal(
  operation: NonNullable<ReturnType<typeof parseControlPanelBindingOperation>>,
  actorId: string,
  panelAccess?: PanelSessionAccess,
) {
  if (operation.id === "apps_create") {
    return {
      ok: true as const,
      principal: {
        kind: "control-plane-token" as const,
        id: actorId,
        // This ceiling scope binds the delegated path; the handler still rechecks
        // the actor's live Org role in D1 before it acts.
        scopes: [`org:${operation.orgId}:owner`],
        orgId: operation.orgId,
        appId: null,
        environmentId: null,
        authDoor: PANEL_AUTH_DOOR,
      },
    };
  }
  // Org membership reads and writes name an Organization and no App, the usage
  // read is Organization-wide, and a Sentry installation wires the whole
  // Organization into one Sentry organization: all of them derive authority from
  // live Org membership rather than from the claimed orgId.
  if (
    operation.id === "organization_usage_get" ||
    operation.id === "organization_members_list" ||
    operation.id === "organization_members_add" ||
    operation.id === "organization_members_update" ||
    operation.id === "organization_members_remove" ||
    operation.id === "sentry_installations_list" ||
    operation.id === "sentry_installations_create" ||
    operation.id === "sentry_installations_delete" ||
    operation.id === "sentry_secret_rotations_create"
  ) {
    return resolvePanelOrgPrincipal(operation.orgId, actorId, panelAccess);
  }
  // Unbound operations name no resource, so there is nothing to derive authority
  // from and nothing to co-scope against. The principal carries the actor and an
  // empty scope set; the handler is the sole authorization authority. For
  // `organizations_create` that is `refuses a provisional door` plus, once
  // SPL-175 lands, the per-User creation quota.
  if (
    operation.id === "experiments_list" ||
    operation.id === "experiments_detail" ||
    operation.id === "experiments_results" ||
    operation.id === "organizations_create"
  ) {
    return {
      ok: true as const,
      principal: {
        kind: "control-plane-token" as const,
        id: actorId,
        scopes: [],
        orgId: null,
        appId: null,
        environmentId: null,
        authDoor: PANEL_AUTH_DOOR,
      },
    };
  }

  // Everything left must name an App, because that is the only authority left to
  // derive. An operation added to the vocabulary without an authority branch
  // reaches here naming no App: that is a fault, and it fails loud as a 500
  // rather than being co-scoped against an `appId` it does not have.
  if (!("appId" in operation)) {
    throw new Error(`control-plane: no authority derivation for operation ${operation.id}`);
  }
  return resolvePanelResourcePrincipal(operation, actorId, panelAccess);
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

/**
 * Authority for an Organization-scoped Panel read. Unlike `apps_create`, the
 * claimed `orgId` is never taken as the binding on its own: the read leaves this
 * Worker over a service binding, so the Org membership is checked in live D1
 * here and a non-member is refused before any Analysis hop.
 */
async function resolvePanelOrgPrincipal(
  orgId: string,
  actorId: string,
  panelAccess?: PanelSessionAccess,
) {
  const access = await panelAccess?.authorizeOrg(actorId, orgId);
  if (!access) {
    return {
      ok: false as const,
      reason: "UNAUTHORIZED" as const,
      error: {
        code: "FORBIDDEN" as const,
        message: "live Organization membership is required",
        details: {},
      },
    };
  }
  return {
    ok: true as const,
    principal: {
      kind: "control-plane-token" as const,
      id: actorId,
      scopes: [`org:${access.orgId}:${access.orgRole}`],
      orgId: access.orgId,
      appId: null,
      environmentId: null,
      authDoor: PANEL_AUTH_DOOR,
    },
  };
}

/**
 * Selected on the App id rather than by excluding a list of ids, so a new
 * operation that names no App cannot land here by default and be co-scoped
 * against an `operation.appId` it does not have.
 */
type AppScopedPanelOperation = Extract<
  NonNullable<ReturnType<typeof parseControlPanelBindingOperation>>,
  { appId: string }
>;

async function resolvePanelResourcePrincipal(
  operation: AppScopedPanelOperation,
  actorId: string,
  panelAccess?: PanelSessionAccess,
) {
  if (!panelAccess) return null;
  const environmentId = "environmentId" in operation ? operation.environmentId : undefined;
  const access = await panelAccess.authorizeApp(actorId, operation.appId, environmentId);
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
