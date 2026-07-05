import { errorCodes, type ErrorCode } from "./errors";
import type { ApiRouteContract } from "./openapi-route";
import { accountRoutes } from "./routes/routes-account";
import { analysisRoutes } from "./routes/routes-analysis";
import { credentialRoutes } from "./routes/routes-credentials";
import { dataPlaneRoutes } from "./routes/routes-data-plane";
import { experimentRoutes } from "./routes/routes-experiments";
import { flagRoutes } from "./routes/routes-flags";
import { privacyRoutes } from "./routes/routes-privacy";

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
export function assertRegistry<const T extends readonly ApiRouteContract[]>(
  routes: T,
): T {
  const seen = new Set<string>();
  for (const route of routes) {
    assertRouteIdentity(route, seen);
    assertRouteErrors(route);
  }
  return Object.freeze([...routes]) as T;
}

export const routeRegistry = assertRegistry([
  ...accountRoutes,
  ...flagRoutes,
  ...experimentRoutes,
  ...credentialRoutes,
  ...analysisRoutes,
  ...privacyRoutes,
  ...dataPlaneRoutes,
]);

/** Lookup by operationId. Returns undefined when no route owns the id. */
export function getRoute(operationId: string): ApiRouteContract | undefined {
  return routeRegistry.find((route) => route.operationId === operationId);
}

/** Every operationId in registry order — the canonical tool/route name list. */
export const operationIds: readonly string[] = routeRegistry.map((route) => route.operationId);
