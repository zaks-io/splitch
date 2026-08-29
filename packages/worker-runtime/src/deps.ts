import type { AuthKind, ErrorResponse, RouteContract } from "@splitch/contracts";
import type { AuthResolver } from "./principal";
import type { Principal } from "./principal";
import type { RateLimiter } from "./rate-limit";

/** Auth kinds that need a resolver. `public` is resolved without one. */
export type ResolvableAuthKind = Exclude<AuthKind, "public">;

export interface AuthenticatedInputResolverArgs {
  contract: RouteContract;
  input: unknown;
  params: Record<string, string>;
  principal: Principal;
  request: Request;
  requestId: string;
}

export type AuthenticatedInputResolution =
  | {
      ok: true;
      input: unknown;
      params: Record<string, string>;
      principal: Principal;
    }
  | { ok: false; error: ErrorResponse };

/**
 * Authenticated, rate-limited request normalization that must run before the
 * registrar compares path scope to the Principal. The default registrar path
 * is identity; Workers opt in only when a public path value needs canonical
 * resolution before co-scope can be enforced.
 */
export type AuthenticatedInputResolver = (
  args: AuthenticatedInputResolverArgs,
) => Promise<AuthenticatedInputResolution> | AuthenticatedInputResolution;

/**
 * Observability hook surface. The guard calls these around the request; a Worker
 * wires them to its logger/tracer. All are optional; omitting them is silent, not
 * an error (observability is not a correctness gate).
 */
export interface Observability {
  onRequest?(ctx: { requestId: string; method: string; path: string }): void;
  /** `cause` is set only on the fault path, and never reaches the response. */
  onError?(ctx: { requestId: string; code: string; status: number; cause?: unknown }): void;
}

/**
 * Worker-local adapters handed to createRegistrar. Each Worker supplies resolvers
 * only for the auth kinds it actually mounts; mounting a route whose kind is
 * absent here fails at boot (fail-loud, never a silently-unguarded route).
 */
export interface RegistrarDeps {
  authResolvers: Partial<Record<ResolvableAuthKind, AuthResolver>>;
  rateLimiter: RateLimiter;
  authenticatedInputResolver?: AuthenticatedInputResolver;
  observability?: Observability;
  /**
   * Extra headers merged onto every response the guard renders. The baseline
   * security policy is always applied; these only add names the baseline does
   * not already carry.
   */
  defaultHeaders?: Record<string, string>;
}
