import {
  isControlPanelSettingsOperation,
  parseControlPanelSettingsOperation,
} from "./control-panel-settings-operation";
import type { ControlPanelOperation } from "./control-panel-identity";

const APPS_PATH = /^\/orgs\/([^/]+)\/apps\/?$/;
const APP_ATTENTION_PATH = /^\/apps\/([^/]+)\/attention-rollup\/?$/;
const EXPERIMENT_DETAIL_PATH = "/control-panel/experiments/detail";
const EXPERIMENT_RESULTS_PATH = "/control-panel/experiments/results";
const EXPERIMENTS_PATH = "/control-panel/experiments/list";
const EXPERIMENT_MUTATION_PATH =
  /^\/apps\/([^/]+)\/envs\/([^/]+)\/experiments\/([^/]+)(\/start)?\/?$/;
const FLAGS_PATH = /^\/apps\/([^/]+)\/flags\/?$/;
const FLAG_CONFIG_PATH = /^\/apps\/([^/]+)\/envs\/([^/]+)\/flags\/([^/]+)\/config\/?$/;
const METRICS_PATH = /^\/apps\/([^/]+)\/metrics\/?$/;
const METRIC_PATH = /^\/apps\/([^/]+)\/metrics\/([^/]+)\/?$/;
const METRIC_COLLECTION_METHODS = {
  GET: "metrics_list",
  POST: "metrics_create",
} as const;
const METRIC_RESOURCE_METHODS = {
  GET: "metrics_get",
  PATCH: "metrics_update",
  DELETE: "metrics_delete",
} as const;

export function parseControlPanelOperation(
  method: string,
  pathname: string,
  panelEnvironmentId?: string,
): ControlPanelOperation | null {
  return (
    parseAppsCreate(method, pathname) ??
    parseAppAttention(method, pathname) ??
    parseExperimentsList(method, pathname) ??
    parseExperimentMutation(method, pathname) ??
    parseFlags(method, pathname, panelEnvironmentId) ??
    parseConfig(method, pathname) ??
    parseControlPanelSettingsOperation(method, pathname) ??
    parseMetrics(method, pathname, panelEnvironmentId)
  );
}

export function isControlPanelOperation(value: unknown): value is ControlPanelOperation {
  if (!isRecord(value) || typeof value.id !== "string") return false;
  if (value.id === "apps_create") return isAppCreateOperation(value);
  if (value.id === "app_attention_rollup_get") return isAppAttentionOperation(value);
  if (isExperimentReadOperationId(value.id)) return hasKeys(value, ["id"]);
  if (isExperimentMutationOperationId(value.id)) return isExperimentMutationOperation(value);
  if (value.id === "flag_config_get") return isFlagConfigOperation(value);
  if (isControlPanelSettingsOperation(value)) return true;
  if (isAppCollectionOperationId(value.id)) return isAppCollectionOperation(value);
  if (isMetricResourceOperationId(value.id)) return isMetricResourceOperation(value);
  return false;
}

/**
 * Every operation is a flat record of its id plus the exact resource ids that
 * scope it, and `isControlPanelOperation` rejects anything with a different key
 * set. So identity is structural equality: a per-variant comparison would have
 * to be extended by hand for each new operation, and the one that got forgotten
 * would silently compare as "same" on its unlisted scope field.
 */
export function sameControlPanelOperation(
  left: ControlPanelOperation,
  right: ControlPanelOperation,
): boolean {
  const claimed = left as Record<string, unknown>;
  const presented = right as Record<string, unknown>;
  const keys = Object.keys(claimed);
  return (
    keys.length === Object.keys(presented).length &&
    keys.every((key) => claimed[key] === presented[key])
  );
}

function parseExperimentMutation(method: string, pathname: string): ControlPanelOperation | null {
  const match = pathname.match(EXPERIMENT_MUTATION_PATH);
  if (!match?.[1] || !match[2] || !match[3]) return null;
  const appId = decodeSegment(match[1]);
  const environmentId = decodeSegment(match[2]);
  const experimentId = decodeSegment(match[3]);
  const isStart = match[4] === "/start";
  if (
    !appId ||
    !environmentId ||
    !experimentId ||
    (isStart ? method !== "POST" : method !== "PATCH")
  ) {
    return null;
  }
  return {
    id: isStart ? "experiments_start" : "experiments_update",
    appId,
    environmentId,
    experimentId,
  };
}

function parseExperimentsList(method: string, pathname: string): ControlPanelOperation | null {
  if (method !== "POST") return null;
  if (pathname === EXPERIMENTS_PATH) return { id: "experiments_list" };
  if (pathname === EXPERIMENT_DETAIL_PATH) return { id: "experiments_detail" };
  if (pathname === EXPERIMENT_RESULTS_PATH) return { id: "experiments_results" };
  return null;
}

function parseAppsCreate(method: string, pathname: string): ControlPanelOperation | null {
  const match = pathname.match(APPS_PATH);
  const orgId = match?.[1] ? decodeSegment(match[1]) : null;
  return method === "POST" && orgId ? { id: "apps_create", orgId } : null;
}

function parseAppAttention(method: string, pathname: string): ControlPanelOperation | null {
  const match = pathname.match(APP_ATTENTION_PATH);
  const appId = match?.[1] ? decodeSegment(match[1]) : null;
  return method === "GET" && appId ? { id: "app_attention_rollup_get", appId } : null;
}

function parseFlags(
  method: string,
  pathname: string,
  environmentValue?: string,
): ControlPanelOperation | null {
  const match = pathname.match(FLAGS_PATH);
  if ((method !== "GET" && method !== "POST") || !match?.[1] || !environmentValue) return null;
  const appId = decodeSegment(match[1]);
  const environmentId = decodeSegment(environmentValue);
  if (!appId || !environmentId) return null;
  return { id: method === "GET" ? "flags_list" : "flags_create", appId, environmentId };
}

function parseConfig(method: string, pathname: string): ControlPanelOperation | null {
  const match = pathname.match(FLAG_CONFIG_PATH);
  if (method !== "GET" || !match?.[1] || !match[2] || !match[3]) return null;
  const appId = decodeSegment(match[1]);
  const environmentId = decodeSegment(match[2]);
  const flagId = decodeSegment(match[3]);
  return appId && environmentId && flagId
    ? { id: "flag_config_get", appId, environmentId, flagId }
    : null;
}

function parseMetrics(
  method: string,
  pathname: string,
  environmentValue?: string,
): ControlPanelOperation | null {
  const environmentId = environmentValue ? decodeSegment(environmentValue) : null;
  if (!environmentId) return null;
  return (
    parseMetricCollection(method, pathname, environmentId) ??
    parseMetricResource(method, pathname, environmentId)
  );
}

function parseMetricCollection(
  method: string,
  pathname: string,
  environmentId: string,
): ControlPanelOperation | null {
  const id = METRIC_COLLECTION_METHODS[method as keyof typeof METRIC_COLLECTION_METHODS];
  const appId = decodeMatch(pathname.match(METRICS_PATH), 1);
  return id && appId ? { id, appId, environmentId } : null;
}

function parseMetricResource(
  method: string,
  pathname: string,
  environmentId: string,
): ControlPanelOperation | null {
  const id = METRIC_RESOURCE_METHODS[method as keyof typeof METRIC_RESOURCE_METHODS];
  const resource = pathname.match(METRIC_PATH);
  const appId = decodeMatch(resource, 1);
  const metricId = decodeMatch(resource, 2);
  return id && appId && metricId ? { id, appId, environmentId, metricId } : null;
}

function decodeMatch(match: RegExpMatchArray | null, index: number): string | null {
  return match?.[index] ? decodeSegment(match[index]) : null;
}

function decodeSegment(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function isAppCreateOperation(value: Record<string, unknown>): boolean {
  if (!hasKeys(value, ["id", "orgId"])) return false;
  return isNonEmptyString(value.orgId);
}

function isAppAttentionOperation(value: Record<string, unknown>): boolean {
  return hasKeys(value, ["id", "appId"]) && isNonEmptyString(value.appId);
}

function isExperimentMutationOperation(value: Record<string, unknown>): boolean {
  if (!hasKeys(value, ["id", "appId", "environmentId", "experimentId"])) return false;
  return [value.appId, value.environmentId, value.experimentId].every(isNonEmptyString);
}

function isFlagConfigOperation(value: Record<string, unknown>): boolean {
  if (!hasKeys(value, ["id", "appId", "environmentId", "flagId"])) return false;
  return [value.appId, value.environmentId, value.flagId].every(isNonEmptyString);
}

function isAppCollectionOperation(value: Record<string, unknown>): boolean {
  if (!hasKeys(value, ["id", "appId", "environmentId"])) return false;
  return [value.appId, value.environmentId].every(isNonEmptyString);
}

function isMetricResourceOperation(value: Record<string, unknown>): boolean {
  if (!hasKeys(value, ["id", "appId", "environmentId", "metricId"])) return false;
  return [value.appId, value.environmentId, value.metricId].every(isNonEmptyString);
}

function isExperimentReadOperationId(id: string): boolean {
  return id === "experiments_list" || id === "experiments_detail" || id === "experiments_results";
}

function isExperimentMutationOperationId(id: string): boolean {
  return id === "experiments_update" || id === "experiments_start";
}

function isAppCollectionOperationId(id: string): boolean {
  return (
    id === "flags_list" || id === "flags_create" || id === "metrics_list" || id === "metrics_create"
  );
}

function isMetricResourceOperationId(id: string): boolean {
  return id === "metrics_get" || id === "metrics_update" || id === "metrics_delete";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => key in value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
