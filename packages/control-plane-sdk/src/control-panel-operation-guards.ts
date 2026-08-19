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
  "experiments_create",
  "metrics_list",
  "metrics_create",
  "segments_list",
  "segments_create",
  "overview_get",
  "settings_get",
  "environment_update",
  "client_key_update",
  "api_keys_create",
  "event_definitions_list",
  "event_definitions_create",
  "environment_exposure_status_get",
] as const;

/** Operations that name no resource, so their claims carry only the id. */
const UNBOUND_OPERATION_IDS = [
  "experiments_list",
  "experiments_detail",
  "experiments_results",
  "organizations_create",
] as const;

const EXPERIMENT_MUTATION_OPERATION_IDS = ["experiments_update", "experiments_start"] as const;

const FLAG_CONFIG_OPERATION_IDS = [
  "flag_config_get",
  "flag_config_update",
  "flag_targeting_rules_replace",
  "flag_config_promote",
] as const;

const APPROVAL_OPERATION_IDS = ["approval_request_get", "approval_request_review"] as const;

/** App Settings operations whose claim names the App and nothing else. */
const APP_SCOPED_OPERATION_IDS = [
  "app_settings_get",
  "apps_update",
  "apps_delete",
  "app_members_list",
  "app_members_add",
] as const;

const APP_MEMBER_RESOURCE_OPERATION_IDS = ["app_members_update", "app_members_remove"] as const;

const METRIC_RESOURCE_OPERATION_IDS = ["metrics_get", "metrics_update", "metrics_delete"] as const;
const EVENT_DEFINITION_RESOURCE_OPERATION_IDS = [
  "event_definitions_get",
  "event_definitions_update",
  "event_definition_versions_create",
  "event_definition_versions_list",
] as const;

const ORG_MEMBER_COLLECTION_OPERATION_IDS = [
  "organization_members_list",
  "organization_members_add",
] as const;

const ORG_MEMBER_RESOURCE_OPERATION_IDS = [
  "organization_members_update",
  "organization_members_remove",
] as const;

const SEGMENT_RESOURCE_OPERATION_IDS = [
  "segments_get",
  "segments_update",
  "segments_delete",
] as const;

type ClaimGuard = (value: Record<string, unknown>) => boolean;

/**
 * One guard per operation id, so adding an id to the vocabulary without stating
 * its claim shape leaves it unclaimable rather than silently falling through to
 * a looser neighbour's check.
 *
 * An unbound claim carries the id and NOTHING else. `hasKeys` is exact-length,
 * so a forged claim cannot smuggle an extra resource field past any of these.
 */
const CLAIM_GUARDS: ReadonlyMap<string, ClaimGuard> = new Map<string, ClaimGuard>([
  ["apps_create", (value) => isResourceOperation(value, "orgId")],
  ["organization_usage_get", (value) => isResourceOperation(value, "orgId")],
  ["app_attention_rollup_get", (value) => isResourceOperation(value, "appId")],
  ...family(APP_SCOPED_OPERATION_IDS, (value) => isResourceOperation(value, "appId")),
  ...family(APP_MEMBER_RESOURCE_OPERATION_IDS, isAppMemberResourceOperation),
  ["api_key_revoke", isApiKeyRevokeOperation],
  ["flag_get", isFlagGetOperation],
  ...family(UNBOUND_OPERATION_IDS, (value) => hasKeys(value, ["id"])),
  ...family(EXPERIMENT_MUTATION_OPERATION_IDS, isExperimentMutationOperation),
  ...family(FLAG_CONFIG_OPERATION_IDS, isFlagConfigOperation),
  ...family(APPROVAL_OPERATION_IDS, isApprovalOperation),
  ...family(SCOPED_OPERATION_IDS, isAppCollectionOperation),
  ...family(METRIC_RESOURCE_OPERATION_IDS, isMetricResourceOperation),
  ...family(EVENT_DEFINITION_RESOURCE_OPERATION_IDS, isEventDefinitionResourceOperation),
  ["event_definition_versions_get", isEventDefinitionVersionOperation],
  ...family(ORG_MEMBER_COLLECTION_OPERATION_IDS, (value) => isResourceOperation(value, "orgId")),
  ...family(ORG_MEMBER_RESOURCE_OPERATION_IDS, isOrgMemberResourceOperation),
  ...family(SEGMENT_RESOURCE_OPERATION_IDS, isSegmentResourceOperation),
]);

function family(ids: readonly string[], guard: ClaimGuard): [string, ClaimGuard][] {
  return ids.map((id) => [id, guard]);
}

export function isControlPanelOperation(value: unknown): value is ControlPanelOperation {
  if (!isRecord(value) || typeof value.id !== "string") return false;
  return CLAIM_GUARDS.get(value.id)?.(value) ?? false;
}

/** Operations named by exactly one resource id: the Org-scoped ones and the App rollup. */
function isResourceOperation(value: Record<string, unknown>, key: string): boolean {
  return hasKeys(value, ["id", key]) && isNonEmptyString(value[key]);
}

function isExperimentMutationOperation(value: Record<string, unknown>): boolean {
  return (
    hasKeys(value, ["id", "appId", "environmentId", "experimentId"]) &&
    hasAppEnvironment(value) &&
    isNonEmptyString(value.experimentId)
  );
}

function isFlagConfigOperation(value: Record<string, unknown>): boolean {
  return (
    hasKeys(value, ["id", "appId", "environmentId", "flagId"]) &&
    hasAppEnvironment(value) &&
    isNonEmptyString(value.flagId)
  );
}

/**
 * `flag_get` carries the dual-selector mode as a fourth claim field. Exact-length
 * `hasKeys` keeps a forged claim from dropping `by` or smuggling a fifth field;
 * only `"id"` and `"key"` are claimable modes.
 */
function isFlagGetOperation(value: Record<string, unknown>): boolean {
  return (
    hasKeys(value, ["id", "appId", "environmentId", "flagId", "by"]) &&
    hasAppEnvironment(value) &&
    isNonEmptyString(value.flagId) &&
    (value.by === "id" || value.by === "key")
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

/**
 * An App-membership mutation names the App and the member being changed. The
 * exact-length check is what keeps a claim minted for one member from being
 * replayed against another, or from smuggling an `environmentId` that would
 * assert a narrower scope than the App-scoped route actually carries.
 */
function isAppMemberResourceOperation(value: Record<string, unknown>): boolean {
  return (
    hasKeys(value, ["id", "appId", "userId"]) &&
    isNonEmptyString(value.appId) &&
    isNonEmptyString(value.userId)
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

function isEventDefinitionResourceOperation(value: Record<string, unknown>): boolean {
  return (
    hasKeys(value, ["id", "appId", "environmentId", "eventDefinitionId"]) &&
    hasAppEnvironment(value) &&
    isNonEmptyString(value.eventDefinitionId)
  );
}

function isEventDefinitionVersionOperation(value: Record<string, unknown>): boolean {
  return (
    hasKeys(value, ["id", "appId", "environmentId", "eventDefinitionId", "versionId"]) &&
    hasAppEnvironment(value) &&
    isNonEmptyString(value.eventDefinitionId) &&
    isNonEmptyString(value.versionId)
  );
}

function isOrgMemberResourceOperation(value: Record<string, unknown>): boolean {
  return (
    hasKeys(value, ["id", "orgId", "userId"]) &&
    isNonEmptyString(value.orgId) &&
    isNonEmptyString(value.userId)
  );
}

function isSegmentResourceOperation(value: Record<string, unknown>): boolean {
  return (
    hasKeys(value, ["id", "appId", "environmentId", "segmentId"]) &&
    hasAppEnvironment(value) &&
    isNonEmptyString(value.segmentId)
  );
}

function hasAppEnvironment(value: Record<string, unknown>): boolean {
  return isNonEmptyString(value.appId) && isNonEmptyString(value.environmentId);
}

function isApiKeyRevokeOperation(value: Record<string, unknown>): boolean {
  return (
    hasKeys(value, ["id", "appId", "environmentId", "keyId"]) &&
    isNonEmptyString(value.appId) &&
    isNonEmptyString(value.environmentId) &&
    isNonEmptyString(value.keyId)
  );
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
  const keys = new Set([...Object.keys(claimed), ...Object.keys(presented)]);
  return [...keys].every(
    (key) =>
      Object.hasOwn(claimed, key) &&
      Object.hasOwn(presented, key) &&
      claimed[key] === presented[key],
  );
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function hasKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return (
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
  );
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
