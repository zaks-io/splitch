import type { OperationCoverage } from "./control-panel-operation-coverage-types";

const APP = "app_1";
const ENV = "env_1";

type ExperimentOperationId =
  | "experiments_list"
  | "experiments_detail"
  | "experiments_results"
  | "experiments_route_resolution"
  | "experiments_create"
  | "experiments_update"
  | "experiments_start"
  | "runs_conclude"
  | "conclusion_promotion_requests_create";

export const EXPERIMENT_ROUTES: Pick<OperationCoverage, ExperimentOperationId> = {
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
  experiments_route_resolution: {
    route: { method: "POST", pathname: "/control-panel/experiments/resolve-route" },
    operation: { id: "experiments_route_resolution" },
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
  runs_conclude: {
    route: {
      method: "POST",
      pathname: `/apps/${APP}/envs/${ENV}/experiments/exp_1/runs/run_1/conclusions`,
    },
    operation: {
      id: "runs_conclude",
      appId: APP,
      environmentId: ENV,
      experimentId: "exp_1",
      runId: "run_1",
    },
  },
  conclusion_promotion_requests_create: {
    route: {
      method: "POST",
      pathname: `/apps/${APP}/envs/${ENV}/experiments/exp_1/runs/run_1/conclusions/conclusion_1/promotion-requests`,
    },
    operation: {
      id: "conclusion_promotion_requests_create",
      appId: APP,
      environmentId: ENV,
      experimentId: "exp_1",
      runId: "run_1",
      conclusionId: "conclusion_1",
    },
  },
};
