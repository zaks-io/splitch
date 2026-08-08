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

import { parseMetrics } from "./panel-metrics-parse.js";
import { parseSegments } from "./panel-segments-parse.js";

export const CONTROL_PANEL_ENVIRONMENT_HEADER = "x-splitch-panel-environment";

export type ControlPanelOperation =
  | { id: "apps_create"; orgId: string }
  | { id: "organization_usage_get"; orgId: string }
  | { id: "app_attention_rollup_get"; appId: string }
  | { id: "experiments_detail" }
  | { id: "experiments_list" }
  | { id: "experiments_results" }
  | { id: "organizations_create" }
  | {
      id: "experiments_update" | "experiments_start";
      appId: string;
      environmentId: string;
      experimentId: string;
    }
  | {
      id: "flags_list" | "flags_create" | "experiments_create";
      appId: string;
      environmentId: string;
    }
  | {
      id:
        | "flag_config_get"
        | "flag_config_update"
        | "flag_targeting_rules_replace"
        /**
         * A promotion reads one Environment and writes another, but only the
         * TARGET is named here: the write is what needs authority, and the
         * source Environment travels in the body, which the delegation's body
         * digest already binds. Naming both would let a claim assert a scope
         * the route does not carry.
         */
        | "flag_config_promote";
      appId: string;
      environmentId: string;
      flagId: string;
    }
  /**
   * An Approval Request is App-scoped, not Environment-scoped: one request can
   * carry Policy contexts for several Environments (an App-level Variant change
   * gated by every Environment that serves it). Binding its claim to a single
   * Environment would name a scope the resource does not have.
   */
  | {
      id: "approval_request_get" | "approval_request_review";
      appId: string;
      approvalRequestId: string;
    }
  | {
      id:
        | "metrics_list"
        | "metrics_create"
        | "segments_list"
        | "segments_create"
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
      id: "segments_get" | "segments_update" | "segments_delete";
      appId: string;
      environmentId: string;
      segmentId: string;
    }
  | {
      id: "api_key_revoke";
      appId: string;
      environmentId: string;
      keyId: string;
    };

const APPS_PATH = /^\/orgs\/([^/]+)\/apps\/?$/;
const ORG_USAGE_PATH = /^\/orgs\/([^/]+)\/usage\/?$/;
const APP_ATTENTION_PATH = /^\/apps\/([^/]+)\/attention-rollup\/?$/;
const EXPERIMENT_DETAIL_PATH = "/control-panel/experiments/detail";
const EXPERIMENT_RESULTS_PATH = "/control-panel/experiments/results";
const EXPERIMENTS_PATH = "/control-panel/experiments/list";
const EXPERIMENT_MUTATION_PATH =
  /^\/apps\/([^/]+)\/envs\/([^/]+)\/experiments\/([^/]+)(\/start)?\/?$/;
const EXPERIMENTS_COLLECTION_PATH = /^\/apps\/([^/]+)\/envs\/([^/]+)\/experiments\/?$/;
const ORGANIZATIONS_PATH = /^\/orgs\/?$/;
const FLAGS_PATH = /^\/apps\/([^/]+)\/flags\/?$/;
const FLAG_CONFIG_PATH = /^\/apps\/([^/]+)\/envs\/([^/]+)\/flags\/([^/]+)\/config\/?$/;
const TARGETING_RULES_PATH = /^\/apps\/([^/]+)\/envs\/([^/]+)\/flags\/([^/]+)\/targeting-rules\/?$/;
const FLAG_PROMOTE_PATH = /^\/apps\/([^/]+)\/envs\/([^/]+)\/flags\/([^/]+)\/promote\/?$/;
const APPROVAL_REQUEST_PATH = /^\/apps\/([^/]+)\/approval-requests\/([^/]+)\/?$/;
const APPROVAL_REVIEWS_PATH = /^\/apps\/([^/]+)\/approval-requests\/([^/]+)\/reviews\/?$/;
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
    parseOrganizationUsage(method, pathname) ??
    parseAppAttention(method, pathname) ??
    parseOrganizationsCreate(method, pathname) ??
    parseExperimentsList(method, pathname) ??
    parseExperimentMutation(method, pathname) ??
    parseExperimentCreate(method, pathname) ??
    parseFlags(method, pathname, panelEnvironmentId) ??
    parseConfig(method, pathname) ??
    parseApproval(method, pathname) ??
    parseEnvironmentSettings(method, pathname) ??
    parseMetrics(method, pathname, panelEnvironmentId) ??
    parseSegments(method, pathname, panelEnvironmentId)
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

/**
 * `GET /orgs/:orgId/usage`. Names the Organization it reads, so the resolver
 * binds the delegation to live Org membership rather than trusting the claim:
 * usage is Organization-wide (ADR-0033), which makes the Org the tenant boundary
 * this read must not cross.
 */
function parseOrganizationUsage(method: string, pathname: string): ControlPanelOperation | null {
  const match = pathname.match(ORG_USAGE_PATH);
  const orgId = match?.[1] ? decodeSegment(match[1]) : null;
  return method === "GET" && orgId ? { id: "organization_usage_get", orgId } : null;
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

/**
 * `PATCH /apps/:appId/envs/:envId/experiments/:experimentId` and its `/start`
 * sibling. Unlike the `experiments_*` reads these DO name a resource, so the
 * resolver binds the delegation to that exact Experiment.
 */
function parseExperimentMutation(method: string, pathname: string): ControlPanelOperation | null {
  const match = pathname.match(EXPERIMENT_MUTATION_PATH);
  if (!match?.[1] || !match[2] || !match[3]) return null;
  const isStart = match[4] === "/start";
  if (isStart ? method !== "POST" : method !== "PATCH") return null;
  const [appId, environmentId, experimentId] = decodedSegments(match.slice(1, 4));
  return appId && environmentId && experimentId
    ? {
        id: isStart ? "experiments_start" : "experiments_update",
        appId,
        environmentId,
        experimentId,
      }
    : null;
}

/**
 * `POST /apps/:appId/envs/:envId/experiments`. Disjoint from
 * `EXPERIMENT_MUTATION_PATH` by construction: that pattern requires a third
 * segment naming an existing Experiment, and a create names none, so the Panel's
 * draft-creation call can never be confused with a mutation of an Experiment the
 * delegation was not bound to.
 */
function parseExperimentCreate(method: string, pathname: string): ControlPanelOperation | null {
  const match = pathname.match(EXPERIMENTS_COLLECTION_PATH);
  if (method !== "POST" || !match?.[1] || !match[2]) return null;
  const [appId, environmentId] = decodedSegments(match.slice(1, 3));
  return appId && environmentId ? { id: "experiments_create", appId, environmentId } : null;
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

/**
 * The three per-Environment Flag Configuration operations the panel may reach.
 * The write pair is named separately from the read so a delegation minted for a
 * config READ can never be replayed as the PATCH that changes what is served.
 */
function parseConfig(method: string, pathname: string): ControlPanelOperation | null {
  for (const [pattern, expectedMethod, id] of [
    [FLAG_CONFIG_PATH, "GET", "flag_config_get"],
    [FLAG_CONFIG_PATH, "PATCH", "flag_config_update"],
    [TARGETING_RULES_PATH, "PUT", "flag_targeting_rules_replace"],
    [FLAG_PROMOTE_PATH, "POST", "flag_config_promote"],
  ] as const) {
    const match = pathname.match(pattern);
    if (method !== expectedMethod || !match?.[1] || !match[2] || !match[3]) continue;
    const [appId, environmentId, flagId] = decodedSegments(match.slice(1, 4));
    return appId && environmentId && flagId ? { id, appId, environmentId, flagId } : null;
  }
  return null;
}

/**
 * Reading an Approval Request and reviewing it are separate operations for the
 * same reason the config read and write are: rendering a proposal's diff must
 * not carry the authority to apply it.
 */
function parseApproval(method: string, pathname: string): ControlPanelOperation | null {
  for (const [pattern, expectedMethod, id] of [
    [APPROVAL_REVIEWS_PATH, "POST", "approval_request_review"],
    [APPROVAL_REQUEST_PATH, "GET", "approval_request_get"],
  ] as const) {
    const match = pathname.match(pattern);
    if (method !== expectedMethod || !match?.[1] || !match[2]) continue;
    const [appId, approvalRequestId] = decodedSegments(match.slice(1, 3));
    return appId && approvalRequestId ? { id, appId, approvalRequestId } : null;
  }
  return null;
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
