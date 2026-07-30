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
  if (isExperimentMutationOperationId(value.id)) return isExperimentMutationOperation(value);
  if (isFlagConfigOperationId(value.id)) return isFlagConfigOperation(value);
  if (isApprovalOperationId(value.id)) return isApprovalOperation(value);
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

function isExperimentMutationOperationId(
  id: string,
): id is "experiments_update" | "experiments_start" {
  return id === "experiments_update" || id === "experiments_start";
}

function isExperimentMutationOperation(value: Record<string, unknown>): boolean {
  return (
    hasKeys(value, ["id", "appId", "environmentId", "experimentId"]) &&
    hasAppEnvironment(value) &&
    isNonEmptyString(value.experimentId)
  );
}

const FLAG_CONFIG_OPERATION_IDS = [
  "flag_config_get",
  "flag_config_update",
  "flag_targeting_rules_replace",
] as const;

const APPROVAL_OPERATION_IDS = ["approval_request_get", "approval_request_review"] as const;

function isFlagConfigOperationId(value: string): boolean {
  return (FLAG_CONFIG_OPERATION_IDS as readonly string[]).includes(value);
}

function isApprovalOperationId(value: string): boolean {
  return (APPROVAL_OPERATION_IDS as readonly string[]).includes(value);
}

function isFlagConfigOperation(value: Record<string, unknown>): boolean {
  return (
    hasKeys(value, ["id", "appId", "environmentId", "flagId"]) &&
    hasAppEnvironment(value) &&
    isNonEmptyString(value.flagId)
  );
}

/**
 * An Approval claim names the App and the request, and NOTHING else. The
 * exact-length check matters more here than elsewhere: an extra `environmentId`
 * smuggled alongside a valid pair would let a forged claim assert a narrower
 * scope than the App-scoped resource actually has.
 */
function isApprovalOperation(value: Record<string, unknown>): boolean {
  return (
    hasKeys(value, ["id", "appId", "approvalRequestId"]) &&
    isNonEmptyString(value.appId) &&
    isNonEmptyString(value.approvalRequestId)
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

/**
 * Every operation is a flat record of its id plus the exact resource ids that
 * scope it, and `isControlPanelOperation` rejects any claim whose key set does
 * not match its id. So identity is structural equality over that key set.
 *
 * This deliberately replaces a per-variant `switch`. That switch was correct
 * for the vocabulary it was written against — its default arm compared appId
 * and environmentId, and every member that reached it carried exactly those two
 * fields. It is the *extension* that is unsafe: a new member with a third
 * scoping field, added without a matching case, silently falls through and gets
 * compared on a subset of its scope, which reads as "same operation" for two
 * different resources. `experiments_update` is exactly such a member. An arm
 * that cannot be extended safely should not exist, so identity is compared
 * structurally and stays total by construction.
 *
 * Members that carry no scope fields (`experiments_list`, `experiments_detail`,
 * `experiments_results`, `organizations_create`) still match on the id alone,
 * as they did under the switch: their key set is `["id"]`, so equal ids compare
 * equal. That is deliberate and documented in `control-panel-operation.ts`.
 */
export function sameOperation(left: ControlPanelOperation, right: ControlPanelOperation): boolean {
  const claimed = left as Record<string, unknown>;
  const presented = right as Record<string, unknown>;
  const keys = Object.keys(claimed);
  return (
    keys.length === Object.keys(presented).length &&
    keys.every((key) => claimed[key] === presented[key])
  );
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
