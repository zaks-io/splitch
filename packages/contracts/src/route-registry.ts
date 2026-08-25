import { type ErrorCode, errorCodes } from "./errors";
import type { ApiRouteContract } from "./openapi-route";
import { type PublicSurface, publicSurfaceFor, type RouteOwner } from "./route-contract";
import { accountRoutes } from "./routes/routes-account";
import { analysisRoutes } from "./routes/routes-analysis";
import { approvalRoutes } from "./routes/routes-approvals";
import { attentionRoutes } from "./routes/routes-attention";
import { credentialRoutes } from "./routes/routes-credentials";
import { convexRoutes } from "./routes/routes-convex";
import { dataPlaneRoutes } from "./routes/routes-data-plane";
import { eventDefinitionRoutes } from "./routes/routes-event-definitions";
import { experimentRoutes } from "./routes/routes-experiments";
import { flagRoutes } from "./routes/routes-flags";
import { privacyRoutes } from "./routes/routes-privacy";
import { segmentRoutes } from "./routes/routes-segments";

/**
 * THE single route registry every Worker mounts, the SDK infers from, and MCP
 * derives from (ADR-0023/0025). It composes the per-domain route lists and is
 * VALIDATED AT MODULE LOAD: a duplicate/missing/mis-cased operationId or an
 * unknown ErrorCode throws on import, so the contract cannot ship malformed
 * (fail loud — the registry is cross-cutting; a silent gap would poison every
 * consumer). Importing this module is the guard.
 */

const OPERATION_ID_PATTERN = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;
const knownErrorCodes = new Set<ErrorCode>(errorCodes);

/** Validate one route's identity + casing against the already-seen id set. */
function assertRouteIdentity(route: ApiRouteContract, seen: Set<string>): void {
  const id = route.operationId;
  if (!OPERATION_ID_PATTERN.test(id)) {
    throw new Error(
      `route-registry: operationId "${id}" is not lower snake_case (resource_operation)`,
    );
  }
  if (route.id !== id) {
    throw new Error(
      `route-registry: route.id "${route.id}" must equal operationId "${id}" (one identity)`,
    );
  }
  if (seen.has(id)) {
    throw new Error(`route-registry: duplicate operationId "${id}"`);
  }
  seen.add(id);
}

/** Validate one route's declared errors are all known ErrorCodes. */
function assertRouteErrors(route: ApiRouteContract): void {
  for (const code of route.errors) {
    if (!knownErrorCodes.has(code)) {
      throw new Error(
        `route-registry: route "${route.operationId}" declares unknown ErrorCode "${code as string}"`,
      );
    }
  }
}

/**
 * Assert the assembled list is a well-formed registry, then return it frozen.
 * Throws on the first violation with an actionable message (which operationId,
 * which bad value) so the failing route is obvious. Exported so the guard test
 * can prove a malformed registry (dup id, unknown code) throws.
 */
export function assertRegistry<const T extends readonly ApiRouteContract[]>(routes: T): T {
  const seen = new Set<string>();
  for (const route of routes) {
    assertRouteIdentity(route, seen);
    assertRouteErrors(route);
  }
  return Object.freeze([...routes]) as T;
}

export const routeRegistry = assertRegistry([
  ...accountRoutes,
  ...approvalRoutes,
  ...attentionRoutes,
  ...flagRoutes,
  ...segmentRoutes,
  ...eventDefinitionRoutes,
  ...experimentRoutes,
  ...credentialRoutes,
  ...convexRoutes,
  ...analysisRoutes,
  ...privacyRoutes,
  ...dataPlaneRoutes,
] as const);

/** Lookup by operationId. Returns undefined when no route owns the id. */
export function getRoute(operationId: string): ApiRouteContract | undefined {
  return routeRegistry.find((route) => route.operationId === operationId);
}

/** Every operationId in registry order — the canonical tool/route name list. */
export const operationIds: readonly string[] = routeRegistry.map((route) => route.operationId);

/**
 * Every route one Worker must mount: the ones it is the public surface for, plus
 * the ones it executes for another surface. A delegated route appears in both
 * lists — the gateway mounts it to authorize and forward, the owner mounts it to
 * execute — which is why this is a union and not a choice.
 *
 * Both clients and Workers read this, so "the CLI addresses it here" and "that
 * Worker answers there" cannot drift apart unnoticed (ADR-0046).
 *
 * This is the whole Worker, not one door. Which routes a given door may answer is
 * `routesSurfacedBy` (the public hostname) or `routesDelegatedTo` (the binding).
 */
export function routesMountedBy(worker: RouteOwner): readonly ApiRouteContract[] {
  return routeRegistry.filter(
    (route) => route.owner === worker || publicSurfaceFor(route) === worker,
  );
}

/**
 * The routes a Worker answers at its OWN public hostname, whether it executes them
 * or forwards them. This is what its public `fetch` may mount, and nothing more:
 * a route this Worker merely executes is addressed somewhere else, so mounting it
 * publicly here would give one operation two live addresses — one the clients are
 * told about and one they are not (ADR-0046).
 *
 * Takes any `RouteOwner`, not just a `PublicSurface`: "this Worker is nobody's
 * public surface, so its public door answers nothing" is the real answer for
 * Analysis, and callers should not have to case-split to ask the question.
 */
export function routesSurfacedBy(worker: RouteOwner): readonly ApiRouteContract[] {
  return routeRegistry.filter((route) => publicSurfaceFor(route) === worker);
}

/**
 * The routes a public surface answers for but does not execute: it authorizes the
 * caller and forwards to the owner over a service binding (ADR-0046).
 *
 * Read from the surface's side (`routesDelegatedBy`) it is what to forward; read
 * from the owner's side (`routesDelegatedTo`) it is the allowlist of operations
 * that may arrive over the binding. One predicate, so the two cannot disagree
 * about what delegation covers.
 */
export function routesDelegatedBy(surface: PublicSurface): readonly ApiRouteContract[] {
  return routeRegistry.filter((route) => delegation(route)?.surface === surface);
}

export function routesDelegatedTo(worker: RouteOwner): readonly ApiRouteContract[] {
  return routeRegistry.filter((route) => delegation(route)?.owner === worker);
}

/** The one definition of "delegated", so the two views above cannot disagree. */
function delegation(route: ApiRouteContract): { surface: PublicSurface; owner: RouteOwner } | null {
  const surface = publicSurfaceFor(route);
  return surface !== null && surface !== route.owner ? { surface, owner: route.owner } : null;
}

/**
 * The operationIds among a Hono app's registered routes, matched by method+path.
 * Paths the registry does not define (health, Control Panel RPC) are not registry
 * routes and drop out; a registry route mounted by the wrong Worker does not.
 */
export function mountedOperationIds(
  routes: readonly { readonly method: string; readonly path: string }[],
): readonly string[] {
  const ids = routes.map(
    ({ method, path }) =>
      routeRegistry.find((route) => route.method === method && route.path === path)?.operationId,
  );
  return [...new Set(ids.filter((id): id is string => id !== undefined))];
}
