import type { AuthKind } from "@splitch/contracts";
import type { AuthResolver } from "./principal";
import type { RateLimiter } from "./rate-limit";

/** Auth kinds that need a resolver. `public` is resolved without one. */
export type ResolvableAuthKind = Exclude<AuthKind, "public">;

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
  observability?: Observability;
  /** Headers merged onto every response the guard renders (e.g. security headers). */
  defaultHeaders?: Record<string, string>;
}
