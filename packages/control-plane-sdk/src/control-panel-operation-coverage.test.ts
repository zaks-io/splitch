import { describe, expect, it } from "vitest";
import { type ControlPanelOperation, parseControlPanelOperation } from "./control-panel-operation";
import { isControlPanelOperation, sameOperation } from "./control-panel-operation-guards";

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

interface Route {
  method: string;
  pathname: string;
  environmentId?: string;
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

const OPERATION_ROUTES: OperationCoverage = {
  apps_create: {
    route: { method: "POST", pathname: "/orgs/org_1/apps" },
    operation: { id: "apps_create", orgId: "org_1" },
  },
  organizations_create: {
    route: { method: "POST", pathname: "/orgs" },
    operation: { id: "organizations_create" },
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

const COVERAGE = Object.entries(OPERATION_ROUTES) as Array<
  [string, { route: Route; operation: ControlPanelOperation }]
>;

function scopeKeys(operation: ControlPanelOperation): string[] {
  return Object.keys(operation).filter((key) => key !== "id");
}

describe("control-panel operation wiring", () => {
  it.each(COVERAGE)("%s has a parser that yields exactly its claim", (_id, {
    route,
    operation,
  }) => {
    expect(parseControlPanelOperation(route.method, route.pathname, route.environmentId)).toEqual(
      operation,
    );
  });

  it.each(COVERAGE)("%s has a predicate that accepts its claim", (_id, { operation }) => {
    expect(isControlPanelOperation(operation)).toBe(true);
  });

  it.each(COVERAGE)("%s rejects a claim with a smuggled extra field", (_id, { operation }) => {
    expect(isControlPanelOperation({ ...operation, smuggled: "x" })).toBe(false);
  });

  it.each(COVERAGE)("%s rejects a claim missing any scope field", (_id, { operation }) => {
    for (const key of scopeKeys(operation)) {
      const { [key]: _dropped, ...rest } = operation as Record<string, unknown>;
      expect(isControlPanelOperation(rest)).toBe(false);
    }
  });

  it.each(COVERAGE)("%s rejects a claim with a blank scope field", (_id, { operation }) => {
    for (const key of scopeKeys(operation)) {
      expect(isControlPanelOperation({ ...operation, [key]: "" })).toBe(false);
    }
  });

  /**
   * The bypass this pins: a delegation minted for one resource must never verify
   * against another. Every scope field has to participate in the comparison, not
   * just the ones a hand-written switch arm remembered.
   */
  it.each(COVERAGE)("%s discriminates on every scope field", (_id, { operation }) => {
    expect(sameOperation(operation, { ...operation })).toBe(true);
    for (const key of scopeKeys(operation)) {
      const other = { ...operation, [key]: "other_value" } as ControlPanelOperation;
      expect(sameOperation(operation, other)).toBe(false);
      expect(sameOperation(other, operation)).toBe(false);
    }
  });

  it("never treats two different operation ids as the same operation", () => {
    for (const [, left] of COVERAGE) {
      for (const [, right] of COVERAGE) {
        if (left.operation.id === right.operation.id) continue;
        expect(sameOperation(left.operation, right.operation)).toBe(false);
      }
    }
  });
});
