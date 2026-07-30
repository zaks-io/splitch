import { getRoute, type RouteContract } from "@splitch/contracts";

/**
 * Resolve a control-plane RouteContract from THE shared route registry by its
 * operationId, failing loud if the id is unknown (a wiring typo must not silently
 * mount nothing). The registry is the single source every Worker mounts from
 * (ADR-0025); this Worker does not author its own route shapes.
 */
export function controlPlaneRoute(operationId: string): RouteContract {
  const route = getRoute(operationId);
  if (!route) {
    throw new Error(`control-plane-api: no route "${operationId}" in the shared registry`);
  }
  return route;
}

/**
 * Apply a concrete required-scope list to a registry route. Returned as a new
 * contract with `scopes` set so the registrar's generic scope step enforces it;
 * the underlying schemas, path, and metadata are the registry's, unchanged.
 *
 * The registry ships these routes with `scopes: []` because App authorization is
 * co-scope (App binding) + D1 membership (ADR-0022). Operation-specific role
 * gates are layered by the Worker that owns each operation.
 */
export function withRequiredScopes(
  contract: RouteContract,
  scopes: readonly string[],
): RouteContract {
  return { ...contract, scopes };
}
