import type { ControlPanelOperation } from "./control-panel-operation";

/**
 * Wiring coverage for the whole operation vocabulary.
 *
 * The failure this exists to catch: a union member lands with no parser (the
 * route 403s at runtime while the build stays green) or with no predicate (a
 * signed claim naming it is rejected, or worse, a claim is compared on a subset
 * of its scope fields). Neither shows up in a typecheck of the union alone.
 *
 * `OPERATION_ROUTES` is keyed by `ControlPanelOperation["id"]`, so adding a
 * member to the union without adding it here is a COMPILE error, and every
 * assertion below runs over the full table.
 */

export interface Route {
  method: string;
  pathname: string;
  environmentId?: string;
  search?: string;
}

/**
 * `Extract<ControlPanelOperation, { id: Id }>` is wrong here: several members
 * declare `id` as a union of literals, and such a member is not assignable to
 * `{ id: OneOfThem }`, so Extract silently yields `never` and every row for
 * those ids becomes unwritable. Narrowing the discriminant on a distributive
 * type parameter keeps all of them reachable.
 */
type NarrowById<Members, Id> = Members extends { id: infer Ids }
  ? Id extends Ids
    ? Omit<Members, "id"> & { id: Id }
    : never
  : never;

type OperationCoverage = {
  [Id in ControlPanelOperation["id"]]: {
    route: Route;
    operation: NarrowById<ControlPanelOperation, Id>;
  };
};

const APP = "app_1";
const ENV = "env_1";

export const OPERATION_ROUTES: OperationCoverage = {
  apps_create: {
    route: { method: "POST", pathname: "/orgs/org_1/apps" },
    operation: { id: "apps_create", orgId: "org_1" },
  },
  organization_usage_get: {
    route: { method: "GET", pathname: "/orgs/org_1/usage" },
    operation: { id: "organization_usage_get", orgId: "org_1" },
  },
  organizations_create: {
    route: { method: "POST", pathname: "/orgs" },
    operation: { id: "organizations_create" },
  },
  organization_members_list: {
    route: { method: "GET", pathname: "/orgs/org_1/members" },
    operation: { id: "organization_members_list", orgId: "org_1" },
  },
  organization_members_add: {
    route: { method: "POST", pathname: "/orgs/org_1/members" },
    operation: { id: "organization_members_add", orgId: "org_1" },
  },
  organization_members_update: {
    route: { method: "PATCH", pathname: "/orgs/org_1/members/user_1" },
    operation: { id: "organization_members_update", orgId: "org_1", userId: "user_1" },
  },
  organization_members_remove: {
    route: { method: "DELETE", pathname: "/orgs/org_1/members/user_1" },
    operation: { id: "organization_members_remove", orgId: "org_1", userId: "user_1" },
  },
  app_attention_rollup_get: {
    route: { method: "GET", pathname: `/apps/${APP}/attention-rollup` },
    operation: { id: "app_attention_rollup_get", appId: APP },
  },
  experiments_list: {
    route: { method: "POST", pathname: "/control-panel/experiments/list" },
    operation: { id: "experiments_list" },
  },
  experiments_detail: {
    route: { method: "POST", pathname: "/control-panel/experiments/detail" },
    operation: { id: "experiments_detail" },
  },
  experiments_results: {
    route: { method: "POST", pathname: "/control-panel/experiments/results" },
    operation: { id: "experiments_results" },
  },
  experiments_create: {
    route: { method: "POST", pathname: `/apps/${APP}/envs/${ENV}/experiments` },
    operation: { id: "experiments_create", appId: APP, environmentId: ENV },
  },
  experiments_update: {
    route: { method: "PATCH", pathname: `/apps/${APP}/envs/${ENV}/experiments/exp_1` },
    operation: {
      id: "experiments_update",
      appId: APP,
      environmentId: ENV,
      experimentId: "exp_1",
    },
  },
  experiments_start: {
    route: { method: "POST", pathname: `/apps/${APP}/envs/${ENV}/experiments/exp_1/start` },
    operation: {
      id: "experiments_start",
      appId: APP,
      environmentId: ENV,
      experimentId: "exp_1",
    },
  },
  flags_list: {
    route: { method: "GET", pathname: `/apps/${APP}/flags`, environmentId: ENV },
    operation: { id: "flags_list", appId: APP, environmentId: ENV },
  },
  flags_create: {
    route: { method: "POST", pathname: `/apps/${APP}/flags`, environmentId: ENV },
    operation: { id: "flags_create", appId: APP, environmentId: ENV },
  },
  flag_get: {
    route: {
      method: "GET",
      pathname: `/apps/${APP}/flags/flag_1`,
      environmentId: ENV,
      search: "by=key",
    },
    operation: { id: "flag_get", appId: APP, environmentId: ENV, flagId: "flag_1", by: "key" },
  },
  flag_config_get: {
    route: { method: "GET", pathname: `/apps/${APP}/envs/${ENV}/flags/flag_1/config` },
    operation: { id: "flag_config_get", appId: APP, environmentId: ENV, flagId: "flag_1" },
  },
  flag_config_update: {
    route: { method: "PATCH", pathname: `/apps/${APP}/envs/${ENV}/flags/flag_1/config` },
    operation: { id: "flag_config_update", appId: APP, environmentId: ENV, flagId: "flag_1" },
  },
  flag_targeting_rules_replace: {
    route: { method: "PUT", pathname: `/apps/${APP}/envs/${ENV}/flags/flag_1/targeting-rules` },
    operation: {
      id: "flag_targeting_rules_replace",
      appId: APP,
      environmentId: ENV,
      flagId: "flag_1",
    },
  },
  flag_config_promote: {
    route: { method: "POST", pathname: `/apps/${APP}/envs/${ENV}/flags/flag_1/promote` },
    operation: { id: "flag_config_promote", appId: APP, environmentId: ENV, flagId: "flag_1" },
  },
  approval_request_get: {
    route: { method: "GET", pathname: `/apps/${APP}/approval-requests/apr_1` },
    operation: { id: "approval_request_get", appId: APP, approvalRequestId: "apr_1" },
  },
  approval_request_review: {
    route: { method: "POST", pathname: `/apps/${APP}/approval-requests/apr_1/reviews` },
    operation: { id: "approval_request_review", appId: APP, approvalRequestId: "apr_1" },
  },
  metrics_list: {
    route: { method: "GET", pathname: `/apps/${APP}/metrics`, environmentId: ENV },
    operation: { id: "metrics_list", appId: APP, environmentId: ENV },
  },
  metrics_create: {
    route: { method: "POST", pathname: `/apps/${APP}/metrics`, environmentId: ENV },
    operation: { id: "metrics_create", appId: APP, environmentId: ENV },
  },
  metrics_get: {
    route: { method: "GET", pathname: `/apps/${APP}/metrics/metric_1`, environmentId: ENV },
    operation: { id: "metrics_get", appId: APP, environmentId: ENV, metricId: "metric_1" },
  },
  metrics_update: {
    route: { method: "PATCH", pathname: `/apps/${APP}/metrics/metric_1`, environmentId: ENV },
    operation: { id: "metrics_update", appId: APP, environmentId: ENV, metricId: "metric_1" },
  },
  metrics_delete: {
    route: { method: "DELETE", pathname: `/apps/${APP}/metrics/metric_1`, environmentId: ENV },
    operation: { id: "metrics_delete", appId: APP, environmentId: ENV, metricId: "metric_1" },
  },
  event_definitions_list: {
    route: { method: "GET", pathname: `/apps/${APP}/event-definitions`, environmentId: ENV },
    operation: { id: "event_definitions_list", appId: APP, environmentId: ENV },
  },
  event_definitions_create: {
    route: { method: "POST", pathname: `/apps/${APP}/event-definitions`, environmentId: ENV },
    operation: { id: "event_definitions_create", appId: APP, environmentId: ENV },
  },
  event_definitions_get: {
    route: { method: "GET", pathname: `/apps/${APP}/event-definitions/ed_1`, environmentId: ENV },
    operation: {
      id: "event_definitions_get",
      appId: APP,
      environmentId: ENV,
      eventDefinitionId: "ed_1",
    },
  },
  event_definitions_update: {
    route: { method: "PATCH", pathname: `/apps/${APP}/event-definitions/ed_1`, environmentId: ENV },
    operation: {
      id: "event_definitions_update",
      appId: APP,
      environmentId: ENV,
      eventDefinitionId: "ed_1",
    },
  },
  event_definition_versions_create: {
    route: {
      method: "POST",
      pathname: `/apps/${APP}/event-definitions/ed_1/versions`,
      environmentId: ENV,
    },
    operation: {
      id: "event_definition_versions_create",
      appId: APP,
      environmentId: ENV,
      eventDefinitionId: "ed_1",
    },
  },
  event_definition_versions_list: {
    route: {
      method: "GET",
      pathname: `/apps/${APP}/event-definitions/ed_1/versions`,
      environmentId: ENV,
    },
    operation: {
      id: "event_definition_versions_list",
      appId: APP,
      environmentId: ENV,
      eventDefinitionId: "ed_1",
    },
  },
  event_definition_versions_get: {
    route: {
      method: "GET",
      pathname: `/apps/${APP}/event-definitions/ed_1/versions/edv_1`,
      environmentId: ENV,
    },
    operation: {
      id: "event_definition_versions_get",
      appId: APP,
      environmentId: ENV,
      eventDefinitionId: "ed_1",
      versionId: "edv_1",
    },
  },
  segments_list: {
    route: { method: "GET", pathname: `/apps/${APP}/segments`, environmentId: ENV },
    operation: { id: "segments_list", appId: APP, environmentId: ENV },
  },
  segments_create: {
    route: { method: "POST", pathname: `/apps/${APP}/segments`, environmentId: ENV },
    operation: { id: "segments_create", appId: APP, environmentId: ENV },
  },
  segments_get: {
    route: { method: "GET", pathname: `/apps/${APP}/segments/segment_1`, environmentId: ENV },
    operation: { id: "segments_get", appId: APP, environmentId: ENV, segmentId: "segment_1" },
  },
  segments_update: {
    route: { method: "PATCH", pathname: `/apps/${APP}/segments/segment_1`, environmentId: ENV },
    operation: { id: "segments_update", appId: APP, environmentId: ENV, segmentId: "segment_1" },
  },
  segments_delete: {
    route: { method: "DELETE", pathname: `/apps/${APP}/segments/segment_1`, environmentId: ENV },
    operation: { id: "segments_delete", appId: APP, environmentId: ENV, segmentId: "segment_1" },
  },
  overview_get: {
    route: { method: "GET", pathname: `/control-panel/apps/${APP}/envs/${ENV}/overview` },
    operation: { id: "overview_get", appId: APP, environmentId: ENV },
  },
  settings_get: {
    route: { method: "GET", pathname: `/control-panel/apps/${APP}/envs/${ENV}/settings` },
    operation: { id: "settings_get", appId: APP, environmentId: ENV },
  },
  environment_update: {
    route: { method: "PATCH", pathname: `/apps/${APP}/envs/${ENV}` },
    operation: { id: "environment_update", appId: APP, environmentId: ENV },
  },
  client_key_update: {
    route: { method: "PATCH", pathname: `/apps/${APP}/envs/${ENV}/client-key` },
    operation: { id: "client_key_update", appId: APP, environmentId: ENV },
  },
  api_keys_create: {
    route: { method: "POST", pathname: `/apps/${APP}/envs/${ENV}/api-keys` },
    operation: { id: "api_keys_create", appId: APP, environmentId: ENV },
  },
  api_key_revoke: {
    route: { method: "POST", pathname: `/apps/${APP}/envs/${ENV}/api-keys/key_1/revoke` },
    operation: { id: "api_key_revoke", appId: APP, environmentId: ENV, keyId: "key_1" },
  },
};
