import type { ApiRouteContract } from "./openapi-route";
import { personalAccessTokenPermissions } from "./personal-access-tokens";
import type { RoutePermission } from "./route-contract";

const permissions: readonly RoutePermission[] = [
  "read",
  ...personalAccessTokenPermissions,
  "derived",
  "owner-cleanup",
  "session-only",
];

/** Reject malformed metadata even when callers bypass the authoring types. */
export function assertRoutePermission(route: ApiRouteContract): void {
  assertTemporaryEnvironmentRoute(route);
  if (route.auth !== "control-plane-token") {
    if ("permission" in route) {
      throw new Error(`route-registry: route "${route.operationId}" must not declare permission`);
    }
    return;
  }
  if (!permissions.includes(route.permission)) {
    throw new Error(
      `route-registry: route "${route.operationId}" has missing or invalid permission`,
    );
  }
  if (route.permission === "read" && route.effects.mutates) {
    throw new Error(`route-registry: mutating route "${route.operationId}" cannot require read`);
  }
  if (
    route.permission === "write" &&
    route.effects.destructive &&
    route.effects.reversibility === "irreversible"
  ) {
    throw new Error(
      `route-registry: destructive irreversible route "${route.operationId}" cannot require write`,
    );
  }
}

function assertTemporaryEnvironmentRoute(route: ApiRouteContract): void {
  if (
    route.temporaryEnvironment &&
    (route.auth !== "control-plane-token" ||
      (route.operationId !== "environments_create" &&
        !/:(environmentId|targetEnvironmentId)\b/.test(route.path)))
  ) {
    throw new Error(
      `route-registry: temporary Environment route "${route.operationId}" requires an Environment path parameter`,
    );
  }
}
