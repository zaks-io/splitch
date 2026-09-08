import { decodedSegments } from "./panel-path-segments.js";

export type ControlPanelExperimentOperation =
  | { id: "experiments_detail" }
  | { id: "experiments_list" }
  | { id: "experiments_results" }
  | { id: "experiments_route_resolution" }
  | {
      id: "experiments_update" | "experiments_start";
      appId: string;
      environmentId: string;
      experimentId: string;
    }
  | {
      id: "runs_conclude";
      appId: string;
      environmentId: string;
      experimentId: string;
      runId: string;
    }
  | {
      id: "conclusion_promotion_requests_create";
      appId: string;
      environmentId: string;
      experimentId: string;
      runId: string;
      conclusionId: string;
    }
  | {
      id: "experiments_create";
      appId: string;
      environmentId: string;
    };

const EXPERIMENT_DETAIL_PATH = "/control-panel/experiments/detail";
const EXPERIMENT_RESULTS_PATH = "/control-panel/experiments/results";
const EXPERIMENT_ROUTE_RESOLUTION_PATH = "/control-panel/experiments/resolve-route";
const EXPERIMENTS_PATH = "/control-panel/experiments/list";
const EXPERIMENT_MUTATION_PATH =
  /^\/apps\/([^/]+)\/envs\/([^/]+)\/experiments\/([^/]+)(\/start)?\/?$/;
const RUN_CONCLUSION_PATH =
  /^\/apps\/([^/]+)\/envs\/([^/]+)\/experiments\/([^/]+)\/runs\/([^/]+)\/conclusions\/?$/;
const CONCLUSION_PROMOTION_REQUEST_PATH =
  /^\/apps\/([^/]+)\/envs\/([^/]+)\/experiments\/([^/]+)\/runs\/([^/]+)\/conclusions\/([^/]+)\/promotion-requests\/?$/;
const EXPERIMENTS_COLLECTION_PATH = /^\/apps\/([^/]+)\/envs\/([^/]+)\/experiments\/?$/;

export function parseExperiments(
  method: string,
  pathname: string,
): ControlPanelExperimentOperation | null {
  return (
    parseExperimentsList(method, pathname) ??
    parseExperimentConclusion(method, pathname) ??
    parseExperimentMutation(method, pathname) ??
    parseExperimentCreate(method, pathname)
  );
}

function parseExperimentsList(
  method: string,
  pathname: string,
): ControlPanelExperimentOperation | null {
  if (method !== "POST") return null;
  if (pathname === EXPERIMENTS_PATH) return { id: "experiments_list" };
  if (pathname === EXPERIMENT_DETAIL_PATH) return { id: "experiments_detail" };
  if (pathname === EXPERIMENT_RESULTS_PATH) return { id: "experiments_results" };
  if (pathname === EXPERIMENT_ROUTE_RESOLUTION_PATH) return { id: "experiments_route_resolution" };
  return null;
}

function parseExperimentConclusion(
  method: string,
  pathname: string,
): ControlPanelExperimentOperation | null {
  if (method !== "POST") return null;
  const promotionMatch = pathname.match(CONCLUSION_PROMOTION_REQUEST_PATH);
  if (promotionMatch?.slice(1, 6).every(Boolean)) {
    const [appId, environmentId, experimentId, runId, conclusionId] = decodedSegments(
      promotionMatch.slice(1, 6),
    );
    return appId && environmentId && experimentId && runId && conclusionId
      ? {
          id: "conclusion_promotion_requests_create",
          appId,
          environmentId,
          experimentId,
          runId,
          conclusionId,
        }
      : null;
  }
  const concludeMatch = pathname.match(RUN_CONCLUSION_PATH);
  if (!concludeMatch?.slice(1, 5).every(Boolean)) return null;
  const [appId, environmentId, experimentId, runId] = decodedSegments(concludeMatch.slice(1, 5));
  return appId && environmentId && experimentId && runId
    ? { id: "runs_conclude", appId, environmentId, experimentId, runId }
    : null;
}

/**
 * Unlike the `experiments_*` reads, mutations name an existing Experiment, so
 * the resolver binds the delegation to that exact resource.
 */
function parseExperimentMutation(
  method: string,
  pathname: string,
): ControlPanelExperimentOperation | null {
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

function parseExperimentCreate(
  method: string,
  pathname: string,
): ControlPanelExperimentOperation | null {
  const match = pathname.match(EXPERIMENTS_COLLECTION_PATH);
  if (method !== "POST" || !match?.[1] || !match[2]) return null;
  const [appId, environmentId] = decodedSegments(match.slice(1, 3));
  return appId && environmentId ? { id: "experiments_create", appId, environmentId } : null;
}
