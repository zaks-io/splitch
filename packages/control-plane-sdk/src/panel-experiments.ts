import type { StatsOutput } from "@splitch/contracts";
import { StatsOutputSchema } from "@splitch/contracts";
import type { ControlPlaneOperationResult } from "./operation-result";
import { parseControlPlaneResponse } from "./operation-result";
import {
  type PanelExperimentDetailInput,
  type PanelExperimentDetailOutput,
  parsePanelExperimentDetailOutput,
} from "./panel-experiment-detail";

export type {
  PanelExperimentDetail,
  PanelExperimentDetailInput,
  PanelExperimentDetailOutput,
  PanelExperimentRun,
} from "./panel-experiment-detail";

const PANEL_EXPERIMENTS_PATH = "/control-panel/experiments/list";
const PANEL_EXPERIMENT_DETAIL_PATH = "/control-panel/experiments/detail";
export const SCOPED_SERVICE_IDENTITY_HEADER = "x-splitch-scoped-service-identity";

export interface PanelExperimentsListInput {
  appId: string;
  environmentId: string;
}

export interface PanelExperimentHealth {
  significanceReached: boolean;
  srmFiring: boolean;
  guardrailBreached: boolean;
}

export interface PanelExperimentListItem {
  id: string;
  name: string;
  status: "draft" | "running" | "ended";
  flag: { id: string; name: string };
  liveRunId: string | null;
  health: PanelExperimentHealth | null;
}

export interface PanelExperimentsListOutput {
  items: PanelExperimentListItem[];
}

export interface ScopedAnalysisIdentity {
  operation: "experiment_results_post";
  actorId: string;
  appId: string;
  environmentId: string;
  experimentId: string;
  runId: string;
}

export function createPanelExperimentsClient(options: { fetch: typeof fetch; baseUrl?: string }) {
  const baseUrl = options.baseUrl ?? "https://control-plane.internal";
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
  };
}

export function scopedAnalysisResultsRequest(identity: ScopedAnalysisIdentity): Request {
  return new Request(
    `https://analysis.internal/apps/${encodeURIComponent(identity.appId)}/envs/${encodeURIComponent(identity.environmentId)}/experiments/${encodeURIComponent(identity.experimentId)}/results`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [SCOPED_SERVICE_IDENTITY_HEADER]: JSON.stringify(identity),
      },
      body: JSON.stringify({ runId: identity.runId }),
    },
  );
}

export async function parseScopedAnalysisResults(response: Response): Promise<StatsOutput> {
  if (!response.ok) {
    throw new Error(`scoped analysis read failed with HTTP ${response.status}`);
  }
  return StatsOutputSchema.parse(await response.json());
}

export function parseScopedAnalysisIdentity(value: string | null): ScopedAnalysisIdentity | null {
  if (!value) return null;
  try {
    const candidate = JSON.parse(value) as Record<string, unknown>;
    if (
      candidate.operation !== "experiment_results_post" ||
      !isNonEmptyString(candidate.actorId) ||
      !isNonEmptyString(candidate.appId) ||
      !isNonEmptyString(candidate.environmentId) ||
      !isNonEmptyString(candidate.experimentId) ||
      !isNonEmptyString(candidate.runId)
    ) {
      return null;
    }
    return candidate as unknown as ScopedAnalysisIdentity;
  } catch {
    return null;
  }
}

function parsePanelExperimentsListOutput(input: unknown) {
  if (!isObject(input) || !Array.isArray(input.items)) return { success: false as const };
  const items = input.items.map(parsePanelExperimentItem);
  if (items.some((item) => item === null)) return { success: false as const };
  return { success: true as const, data: { items } as PanelExperimentsListOutput };
}

function parsePanelExperimentItem(input: unknown): PanelExperimentListItem | null {
  if (!isObject(input) || !isObject(input.flag)) return null;
  if (
    !isNonEmptyString(input.id) ||
    !isNonEmptyString(input.name) ||
    !isLifecycle(input.status) ||
    !isNonEmptyString(input.flag.id) ||
    !isNonEmptyString(input.flag.name) ||
    !(input.liveRunId === null || isNonEmptyString(input.liveRunId))
  ) {
    return null;
  }
  const health = parseHealth(input.health);
  if (input.health !== null && health === null) return null;
  return {
    id: input.id,
    name: input.name,
    status: input.status,
    flag: { id: input.flag.id, name: input.flag.name },
    liveRunId: input.liveRunId,
    health,
  };
}

function parseHealth(input: unknown): PanelExperimentHealth | null {
  if (input === null) return null;
  if (
    !isObject(input) ||
    typeof input.significanceReached !== "boolean" ||
    typeof input.srmFiring !== "boolean" ||
    typeof input.guardrailBreached !== "boolean"
  ) {
    return null;
  }
  return {
    significanceReached: input.significanceReached,
    srmFiring: input.srmFiring,
    guardrailBreached: input.guardrailBreached,
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isLifecycle(value: unknown): value is PanelExperimentListItem["status"] {
  return value === "draft" || value === "running" || value === "ended";
}
