/**
 * The operation vocabulary of the Control Panel binding protocol.
 *
 * Split out of `control-panel-identity.ts` so the delegation envelope (signing,
 * expiry, replay, body digest) and the set of operations it may name are two
 * modules instead of one 500-line file. Nothing about the protocol changed in
 * the split.
 *
 * Most operations name the resource they act on, and the resolver derives the
 * principal's authority from that name against live D1. Two families do not:
 * the `experiments_*` reads and `organizations_create`. Neither has a resource
 * to bind against at request time — the experiment list is filtered by the actor
 * downstream, and an Organization that does not exist yet cannot be co-scoped.
 * Those delegations therefore carry ONLY the actor, expiry, nonce, and body
 * digest, and the Worker decides authorization on its own. That is the design,
 * not a gap: see `organizations-client.ts`.
 */

export const CONTROL_PANEL_ENVIRONMENT_HEADER = "x-splitch-panel-environment";

export type ControlPanelOperation =
  | { id: "apps_create"; orgId: string }
  | { id: "app_attention_rollup_get"; appId: string }
  | { id: "experiments_detail" }
  | { id: "experiments_list" }
  | { id: "experiments_results" }
  | { id: "organizations_create" }
  | { id: "flags_list" | "flags_create"; appId: string; environmentId: string }
  | { id: "flag_config_get"; appId: string; environmentId: string; flagId: string }
  | {
      id:
        | "metrics_list"
        | "metrics_create"
        | "overview_get"
        | "settings_get"
        | "environment_update"
        | "client_key_update"
        | "api_keys_create";
      appId: string;
      environmentId: string;
    }
  | {
      id: "metrics_get" | "metrics_update" | "metrics_delete";
      appId: string;
      environmentId: string;
      metricId: string;
    }
  | {
      id: "api_key_revoke";
      appId: string;
      environmentId: string;
      keyId: string;
    };

const APPS_PATH = /^\/orgs\/([^/]+)\/apps\/?$/;
const APP_ATTENTION_PATH = /^\/apps\/([^/]+)\/attention-rollup\/?$/;
const EXPERIMENT_DETAIL_PATH = "/control-panel/experiments/detail";
const EXPERIMENT_RESULTS_PATH = "/control-panel/experiments/results";
const EXPERIMENTS_PATH = "/control-panel/experiments/list";
const ORGANIZATIONS_PATH = /^\/orgs\/?$/;
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
const OVERVIEW_PATH = /^\/control-panel\/apps\/([^/]+)\/envs\/([^/]+)\/overview\/?$/;
const SETTINGS_PATH = /^\/control-panel\/apps\/([^/]+)\/envs\/([^/]+)\/settings\/?$/;
const ENVIRONMENT_PATH = /^\/apps\/([^/]+)\/envs\/([^/]+)\/?$/;
const CLIENT_KEY_PATH = /^\/apps\/([^/]+)\/envs\/([^/]+)\/client-key\/?$/;
const API_KEYS_PATH = /^\/apps\/([^/]+)\/envs\/([^/]+)\/api-keys\/?$/;
const API_KEY_REVOKE_PATH = /^\/apps\/([^/]+)\/envs\/([^/]+)\/api-keys\/([^/]+)\/revoke\/?$/;
export function parseControlPanelOperation(
  method: string,
  pathname: string,
  panelEnvironmentId?: string,
): ControlPanelOperation | null {
  return (
    parseAppsCreate(method, pathname) ??
    parseAppAttention(method, pathname) ??
    parseOrganizationsCreate(method, pathname) ??
    parseExperimentsList(method, pathname) ??
    parseFlags(method, pathname, panelEnvironmentId) ??
    parseConfig(method, pathname) ??
    parseEnvironmentSettings(method, pathname) ??
    parseMetrics(method, pathname, panelEnvironmentId)
  );
}

/**
 * `POST /orgs`. Ordered AFTER `parseAppsCreate` so the two `/orgs…` shapes can
 * never be confused: `APPS_PATH` requires a trailing `/apps` segment and this
 * one requires the collection root, so the patterns are disjoint by construction
 * rather than by ordering luck.
 */
function parseOrganizationsCreate(method: string, pathname: string): ControlPanelOperation | null {
  return method === "POST" && ORGANIZATIONS_PATH.test(pathname)
    ? { id: "organizations_create" }
    : null;
}

function parseAppAttention(method: string, pathname: string): ControlPanelOperation | null {
  const match = pathname.match(APP_ATTENTION_PATH);
  const appId = match?.[1] ? decodeSegment(match[1]) : null;
  return method === "GET" && appId ? { id: "app_attention_rollup_get", appId } : null;
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

function parseEnvironmentSettings(method: string, pathname: string): ControlPanelOperation | null {
  return parseApiKeyRevoke(method, pathname) ?? parseScopedSettingsOperation(method, pathname);
}

function parseApiKeyRevoke(method: string, pathname: string): ControlPanelOperation | null {
  if (method !== "POST") return null;
  const revoke = pathname.match(API_KEY_REVOKE_PATH);
  if (!revoke?.[1] || !revoke[2] || !revoke[3]) return null;
  const [appId, environmentId, keyId] = decodedSegments(revoke.slice(1, 4));
  return appId && environmentId && keyId
    ? { id: "api_key_revoke", appId, environmentId, keyId }
    : null;
}

function parseScopedSettingsOperation(
  method: string,
  pathname: string,
): ControlPanelOperation | null {
  for (const [pattern, expectedMethod, id] of [
    [OVERVIEW_PATH, "GET", "overview_get"],
    [SETTINGS_PATH, "GET", "settings_get"],
    [ENVIRONMENT_PATH, "PATCH", "environment_update"],
    [CLIENT_KEY_PATH, "PATCH", "client_key_update"],
    [API_KEYS_PATH, "POST", "api_keys_create"],
  ] as const) {
    const match = pathname.match(pattern);
    if (method !== expectedMethod || !match?.[1] || !match[2]) continue;
    const [appId, environmentId] = decodedSegments(match.slice(1, 3));
    return appId && environmentId ? { id, appId, environmentId } : null;
  }
  return null;
}

function decodedSegments(values: string[]): Array<string | null> {
  return values.map(decodeSegment);
}

function decodeSegment(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}
