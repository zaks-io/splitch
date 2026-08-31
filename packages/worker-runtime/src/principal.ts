import type {
  AccessTokenAuthorization,
  AuthDoor,
  AuthKind,
  ErrorResponse,
  UserRole,
} from "@splitch/contracts";

export interface PrincipalMemberships {
  organizations: readonly {
    id: string;
    role: UserRole;
  }[];
  apps: readonly {
    id: string;
    organizationId: string;
    role: UserRole;
  }[];
}

/**
 * The resolved caller. Produced by a Worker-provided AuthResolver, consumed by
 * the guard's scope and co-scope checks and handed to the route handler.
 *
 * `orgId`/`appId`/`environmentId` are the scope the credential is bound to. The
 * guard enforces that they match the route's path params where the contract
 * requires co-scoping (ADR-0027). A `null` means the credential is not bound to
 * one value on that axis. A selector resolver may bind it to one App already
 * named by a matching signed scope; otherwise a selector-bound credential is
 * FORBIDDEN on a null co-scope axis. Membership-wide read tokens instead
 * co-scope against their complete live `memberships` set.
 *
 * `orgId` follows the same single-value-or-null shape as `appId`: it is the one
 * Org the credential is bound to. A token naming zero or many Orgs is initially
 * org-unbound (null), so the guard FORBIDs it from an `:orgId` route rather than
 * silently picking one. A live MCP principal may be bound after delegation
 * validation to the exact canonical route Org already present in its resolved
 * membership scopes.
 */
export interface Principal {
  kind: AuthKind;
  /** Stable identifier for the credential/actor, for observability and audit. */
  id: string;
  scopes: readonly string[];
  orgId: string | null;
  appId: string | null;
  environmentId: string | null;
  /** Present only on a token whose claim structurally grants membership-wide reads. */
  authorization?: AccessTokenAuthorization;
  /** Live D1 result for a membership-wide token. Never populated from JWT claims. */
  memberships?: PrincipalMemberships;
  /** Membership scopes were resolved live after a signed MCP delegation was validated. */
  liveMembership?: true;
  /**
   * Which door minted this credential, when the auth kind carries one. `null`
   * for kinds with no door concept (public, Client Key, API Key) — those are
   * never provisional, so a handler asking "is this principal provisional?"
   * gets `false` rather than a guess.
   */
  authDoor: AuthDoor | null;
}

/**
 * Outcome of an auth resolver. Resolvers never throw for the ordinary
 * unauthenticated/revoked cases — they return a typed failure the guard renders
 * through the shared ErrorResponse. Throwing is reserved for genuine faults
 * (which the guard maps to INTERNAL_SERVER_ERROR, fail-loud).
 */
export type AuthResult =
  | { ok: true; principal: Principal }
  | { ok: false; reason: "UNAUTHORIZED" | "CREDENTIAL_REVOKED"; error?: ErrorResponse };

/**
 * Port a Worker implements per auth kind it mounts. The guard dispatches on the
 * route contract's `auth` field; a route whose kind has no resolver fails at
 * boot (see assertResolvable in registrar).
 */
export type AuthResolver = (request: Request) => Promise<AuthResult> | AuthResult;

/** Public routes need no resolver; this sentinel principal stands in for them. */
export const PUBLIC_PRINCIPAL: Principal = {
  kind: "public",
  id: "anonymous",
  scopes: [],
  orgId: null,
  appId: null,
  environmentId: null,
  authDoor: null,
};
