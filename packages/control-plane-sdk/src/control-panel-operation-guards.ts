import type { ControlPanelOperation } from "./control-panel-operation";

/**
 * Structural validation of an operation claim carried inside a signed delegation.
 *
 * This is the half of the protocol that runs on ATTACKER-SUPPLIED input: the
 * parser above derives an operation from a request we routed ourselves, while
 * these guards decide whether a claim lifted out of a delegation token is a
 * real operation at all. Every check is exact-length (`hasKeys`), so a forged
 * claim cannot smuggle an extra resource field alongside a valid id.
 */

const SCOPED_OPERATION_IDS = [
  "flags_list",
  "flags_create",
  "metrics_list",
  "metrics_create",
  "overview_get",
  "settings_get",
  "environment_update",
  "client_key_update",
  "api_keys_create",
] as const;

/** Operations that name no resource, so their claims carry only the id. */
const UNBOUND_OPERATION_IDS = [
  "experiments_list",
  "experiments_detail",
  "experiments_results",
  "organizations_create",
] as const;

export function isControlPanelOperation(value: unknown): value is ControlPanelOperation {
  if (!isRecord(value) || typeof value.id !== "string") return false;
  if (value.id === "apps_create") return isResourceOperation(value, "orgId");
  if (value.id === "app_attention_rollup_get") return isResourceOperation(value, "appId");
  // An unbound claim carries the id and NOTHING else. `hasKeys` is exact-length,
  // so a forged claim cannot smuggle an extra resource field past this.
  if (isUnboundOperationId(value.id)) return hasKeys(value, ["id"]);
  if (value.id === "flag_config_get") return isFlagConfigOperation(value);
  if (isScopedOperationId(value.id)) return isAppCollectionOperation(value);
  if (isMetricResourceOperationId(value.id)) return isMetricResourceOperation(value);
  if (value.id === "api_key_revoke") {
    return isApiKeyRevokeOperation(value);
  }
  return false;
}

function isUnboundOperationId(value: string): boolean {
  return (UNBOUND_OPERATION_IDS as readonly string[]).includes(value);
}

/** Operations named by exactly one resource id: apps_create (Org) and the App rollup. */
function isResourceOperation(value: Record<string, unknown>, key: string): boolean {
  return hasKeys(value, ["id", key]) && isNonEmptyString(value[key]);
}

function isFlagConfigOperation(value: Record<string, unknown>): boolean {
  return (
    hasKeys(value, ["id", "appId", "environmentId", "flagId"]) &&
    hasAppEnvironment(value) &&
    isNonEmptyString(value.flagId)
  );
}

function isAppCollectionOperation(value: Record<string, unknown>): boolean {
  return hasKeys(value, ["id", "appId", "environmentId"]) && hasAppEnvironment(value);
}

function isMetricResourceOperation(value: Record<string, unknown>): boolean {
  return (
    hasKeys(value, ["id", "appId", "environmentId", "metricId"]) &&
    hasAppEnvironment(value) &&
    isNonEmptyString(value.metricId)
  );
}

function hasAppEnvironment(value: Record<string, unknown>): boolean {
  return isNonEmptyString(value.appId) && isNonEmptyString(value.environmentId);
}

function isMetricResourceOperationId(
  id: string,
): id is "metrics_get" | "metrics_update" | "metrics_delete" {
  return id === "metrics_get" || id === "metrics_update" || id === "metrics_delete";
}

function isApiKeyRevokeOperation(value: Record<string, unknown>): boolean {
  return (
    hasKeys(value, ["id", "appId", "environmentId", "keyId"]) &&
    isNonEmptyString(value.appId) &&
    isNonEmptyString(value.environmentId) &&
    isNonEmptyString(value.keyId)
  );
}

function isScopedOperationId(value: string): value is (typeof SCOPED_OPERATION_IDS)[number] {
  return (SCOPED_OPERATION_IDS as readonly string[]).includes(value);
}

export function sameOperation(left: ControlPanelOperation, right: ControlPanelOperation): boolean {
  if (left.id !== right.id) return false;
  switch (left.id) {
    case "apps_create":
      return right.id === "apps_create" && left.orgId === right.orgId;
    case "app_attention_rollup_get":
      return right.id === "app_attention_rollup_get" && left.appId === right.appId;
    case "experiments_list":
    case "experiments_detail":
    case "experiments_results":
    case "organizations_create":
      return true;
    case "flag_config_get":
      return (
        right.id === "flag_config_get" &&
        left.appId === right.appId &&
        left.environmentId === right.environmentId &&
        left.flagId === right.flagId
      );
    case "metrics_get":
    case "metrics_update":
    case "metrics_delete":
      return (
        "metricId" in right &&
        left.appId === right.appId &&
        left.environmentId === right.environmentId &&
        left.metricId === right.metricId
      );
    case "api_key_revoke":
      return (
        "keyId" in right &&
        left.appId === right.appId &&
        left.environmentId === right.environmentId &&
        left.keyId === right.keyId
      );
    default:
      return (
        "appId" in right &&
        "environmentId" in right &&
        left.appId === right.appId &&
        left.environmentId === right.environmentId
      );
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function hasKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => key in value);
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
