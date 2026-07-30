import type { StatsOutput } from "@splitch/contracts";
import type { ControlPlaneOperationResult } from "./operation-result";
import { parseControlPlaneResponse } from "./operation-result";
import { createExperimentsClient } from "./experiments-client";
import {
  type PanelExperimentDetailInput,
  type PanelExperimentDetailOutput,
  parsePanelExperimentDetailOutput,
} from "./panel-experiment-detail";
import {
  type PanelExperimentsListInput,
  type PanelExperimentsListOutput,
  parsePanelExperimentsListOutput,
} from "./panel-experiments-list";
import {
  parseScopedAnalysisIdentity,
  parseScopedAnalysisResults,
  SCOPED_SERVICE_IDENTITY_HEADER,
  ScopedAnalysisError,
  scopedAnalysisResultsRequest,
} from "./panel-experiments-scoped-analysis";
import {
  type PanelExperimentResultsInput,
  type PanelExperimentResultsOutput,
  PanelExperimentResultsOutputSchema,
  parsePanelExperimentResultsOutput,
} from "./panel-experiment-results";

/**
 * The Panel's read/write surface for Experiments. This module is the package
 * subpath consumers import (`@splitch/control-plane-sdk/panel-experiments`), so
 * the list projection and the scoped-analysis protocol are re-exported here even
 * though they live in their own modules.
 */

export type {
  PanelExperimentDetail,
  PanelExperimentDetailInput,
  PanelExperimentDetailOutput,
  PanelExperimentRun,
} from "./panel-experiment-detail";
export { parsePanelExperimentDetailOutput };
export type {
  PanelExperimentHealth,
  PanelExperimentListItem,
  PanelExperimentsListInput,
  PanelExperimentsListOutput,
} from "./panel-experiments-list";
export type {
  PanelExperimentResultsInput,
  PanelExperimentResultsOutput,
} from "./panel-experiment-results";
export { PanelExperimentResultsOutputSchema, parsePanelExperimentResultsOutput };
export type { ScopedAnalysisIdentity } from "./panel-experiments-scoped-analysis";
export {
  parseScopedAnalysisIdentity,
  parseScopedAnalysisResults,
  SCOPED_SERVICE_IDENTITY_HEADER,
  ScopedAnalysisError,
  scopedAnalysisResultsRequest,
};

const PANEL_EXPERIMENTS_PATH = "/control-panel/experiments/list";
const PANEL_EXPERIMENT_DETAIL_PATH = "/control-panel/experiments/detail";
const PANEL_EXPERIMENT_RESULTS_PATH = "/control-panel/experiments/results";

export function createPanelExperimentsClient(options: { fetch: typeof fetch; baseUrl?: string }) {
  const baseUrl = options.baseUrl ?? "https://control-plane.internal";
  const mutations = createExperimentsClient({ fetch: options.fetch, baseUrl });
  return {
    async list(
      input: PanelExperimentsListInput,
    ): Promise<ControlPlaneOperationResult<PanelExperimentsListOutput>> {
      const response = await options.fetch(new URL(PANEL_EXPERIMENTS_PATH, baseUrl), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      return parseControlPlaneResponse<PanelExperimentsListOutput>(
        response,
        "panel_experiments_list",
        {
          safeParse: parsePanelExperimentsListOutput,
        },
      );
    },
    async detail(
      input: PanelExperimentDetailInput,
    ): Promise<ControlPlaneOperationResult<PanelExperimentDetailOutput>> {
      const response = await options.fetch(new URL(PANEL_EXPERIMENT_DETAIL_PATH, baseUrl), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      return parseControlPlaneResponse<PanelExperimentDetailOutput>(
        response,
        "panel_experiment_detail",
        {
          safeParse: parsePanelExperimentDetailOutput,
        },
      );
    },
    async results(
      input: PanelExperimentResultsInput,
    ): Promise<ControlPlaneOperationResult<PanelExperimentResultsOutput>> {
      const response = await options.fetch(new URL(PANEL_EXPERIMENT_RESULTS_PATH, baseUrl), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      return parseControlPlaneResponse<PanelExperimentResultsOutput>(
        response,
        "panel_experiment_results",
        {
          safeParse: parsePanelExperimentResultsOutput,
        },
      );
    },
    update: mutations.update,
    start: mutations.start,
  };
}

/**
 * Single source for what "this Run needs attention" means. The Experiment list and
 * the Environment attention rollup MUST agree: a divergence here silently hides
 * attention on one surface while showing it on the other.
 */
export function srmFiring(results: StatsOutput): boolean {
  return (
    results.srm.srm_is_mismatch ||
    results.srm.activated_srm_mismatch === true ||
    results.health.activation_balance_mismatch === true
  );
}

export function guardrailBreached(results: StatsOutput): boolean {
  return results.guardrail_results.some((result) => result.is_breached === true);
}
