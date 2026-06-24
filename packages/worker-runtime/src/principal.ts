import type { AuthKind } from "@splitch/contracts";

/**
 * The resolved caller. Produced by a Worker-provided AuthResolver, consumed by
 * the guard's scope and co-scope checks and handed to the route handler.
 *
 * `appId`/`environmentId` are the scope the credential is bound to. The guard
 * enforces that they match the route's path params where the contract requires
 * co-scoping (ADR-0027). A `null` means the credential is not bound to that axis
 * (e.g. an org-level control-plane token); a route that requires co-scope on a
 * null axis is a FORBIDDEN.
 */
export interface Principal {
  kind: AuthKind;
  /** Stable identifier for the credential/actor, for observability and audit. */
  id: string;
  scopes: readonly string[];
  appId: string | null;
  environmentId: string | null;
}

/**
 * Outcome of an auth resolver. Resolvers never throw for the ordinary
 * unauthenticated/revoked cases — they return a typed failure the guard renders
 * through the shared ErrorResponse. Throwing is reserved for genuine faults
 * (which the guard maps to INTERNAL_SERVER_ERROR, fail-loud).
 */
export type AuthResult =
  | { ok: true; principal: Principal }
  | { ok: false; reason: "UNAUTHORIZED" | "CREDENTIAL_REVOKED" };

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
  appId: null,
  environmentId: null,
};
