import { getRoute, type RouteContract } from "@splitch/contracts";

const LEGACY_APPROVAL_RUNTIME_OPERATIONS = new Set([
  "flag_variants_update",
  "flag_config_update",
  "flag_targeting_rules_replace",
  "flags_promote",
  "experiments_start",
]);

const LEGACY_CONFIRMATION_OPERATIONS = new Set([
  "flag_config_update",
  "flag_targeting_rules_replace",
  "flags_promote",
  "experiments_start",
]);

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
  return LEGACY_APPROVAL_RUNTIME_OPERATIONS.has(operationId)
    ? legacyApprovalRuntimeRoute(route, operationId)
    : route;
}

/**
 * Deprecated SPL-150 bridge. The shared registry exposes the final Approval
 * contract while the legacy runtime still accepts `confirm` and has no durable
 * idempotency layer. Remove this adapter when SPL-150 replaces that path.
 */
function legacyApprovalRuntimeRoute(route: RouteContract, operationId: string): RouteContract {
  const input = objectSchema(route.input, `${operationId} input`);
  const body = objectSchema(input.shape.body, `${operationId} body`);
  const legacyBody = body.omit({ review: true, idempotency_key: true });
  const compatibleBody = LEGACY_CONFIRMATION_OPERATIONS.has(operationId)
    ? legacyBody.extend({ confirm: legacyConfirmationBooleanSchema() })
    : legacyBody;
  const runtimeBody =
    operationId === "experiments_start" ? compatibleBody.optional() : compatibleBody;

  return {
    ...route,
    input: input.extend({ body: runtimeBody }) as unknown as RouteContract["input"],
    idempotency: "none",
  };
}

interface RuntimeObjectSchema {
  readonly shape: Record<string, unknown>;
  omit(mask: Record<string, true>): RuntimeObjectSchema;
  extend(shape: Record<string, unknown>): RuntimeObjectSchema;
  optional(): unknown;
}

function objectSchema(schema: unknown, label: string): RuntimeObjectSchema {
  if (
    typeof schema !== "object" ||
    schema === null ||
    !("shape" in schema) ||
    !("omit" in schema) ||
    !("extend" in schema) ||
    !("optional" in schema)
  ) {
    throw new Error(`control-plane-api: ${label} is not an object schema`);
  }
  return schema as RuntimeObjectSchema;
}

function legacyConfirmationBooleanSchema(): unknown {
  const configRoute = getRoute("flag_config_update");
  if (!configRoute) {
    throw new Error('control-plane-api: no route "flag_config_update" in the shared registry');
  }
  const input = objectSchema(configRoute.input, "flag_config_update input");
  const body = objectSchema(input.shape.body, "flag_config_update body");
  return body.shape.enabled;
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
