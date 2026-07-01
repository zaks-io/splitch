import { defineRoute, type RouteContract } from "@splitch/contracts";
import { z } from "zod";
import type { RegistrarDeps } from "./deps.js";
import type { AuthResolver, Principal } from "./principal.js";
import type { RateLimiter } from "./rate-limit.js";

/**
 * Shared fixtures for the guard test matrix: route-contract builders + fake
 * adapters. Not part of the package's public surface (not re-exported from
 * index); imported only by *.test.ts.
 */

/** A body-bearing input schema: requires `name` in the JSON body. */
export const BodyInput = z.object({
  body: z.object({ name: z.string() }),
});

/** A no-body input schema that tolerates any params/query/headers. */
const OpenInput = z.object({
  params: z.record(z.string(), z.string()),
});

const OkOutput = z.object({ ok: z.boolean() });

export function route(overrides: Partial<RouteContract> = {}): RouteContract {
  return defineRoute({
    id: "test.route",
    owner: "control-plane-api",
    method: "POST",
    path: "/things",
    input: OpenInput,
    output: OkOutput,
    auth: "public",
    scopes: [],
    rateLimit: "none",
    idempotency: "none",
    errors: [],
    ...overrides,
  });
}

export function principal(overrides: Partial<Principal> = {}): Principal {
  return {
    kind: "control-plane-token",
    id: "actor_1",
    scopes: [],
    orgId: null,
    appId: null,
    environmentId: null,
    ...overrides,
  };
}

export function resolverFor(p: Principal): AuthResolver {
  return () => ({ ok: true, principal: p });
}

export const rejectingResolver: AuthResolver = () => ({ ok: false, reason: "UNAUTHORIZED" });

const allowLimiter: RateLimiter = () => ({ limited: false });
export const denyLimiter: RateLimiter = () => ({ limited: true, retryAfterMs: 2000 });
export const throwingLimiter: RateLimiter = () => {
  throw new Error("rate-limit binding unavailable");
};

export function deps(overrides: Partial<RegistrarDeps> = {}): RegistrarDeps {
  return {
    authResolvers: {},
    rateLimiter: allowLimiter,
    ...overrides,
  };
}

/** Echo handler: returns 200 with the validated input so tests can assert it ran. */
export function okHandler(): Response {
  return Response.json({ ok: true });
}
