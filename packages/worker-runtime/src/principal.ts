import type { AuthDoor, AuthKind, ErrorResponse } from "@splitch/contracts";

/**
 * The resolved caller. Produced by a Worker-provided AuthResolver, consumed by
 * the guard's scope and co-scope checks and handed to the route handler.
 *
 * `orgId`/`appId`/`environmentId` are the scope the credential is bound to. The
 * guard enforces that they match the route's path params where the contract
 * requires co-scoping (ADR-0027). A `null` means the credential is not bound to
 * that axis; a route that requires co-scope on a null axis is a FORBIDDEN.
 *
 * `orgId` follows the same single-value-or-null shape as `appId`: it is the one
 * Org the credential is bound to, meaningful only when the token names exactly
 * one Org (the agent-first provisional Org from Door B). A token naming zero or
 * many Orgs is org-unbound (null), so the guard FORBIDs it from an `:orgId`
 * route rather than silently picking one.
 */
export interface Principal {
  kind: AuthKind;
  /** Stable identifier for the credential/actor, for observability and audit. */
  id: string;
  scopes: readonly string[];
  orgId: string | null;
  appId: string | null;
  environmentId: string | null;
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
