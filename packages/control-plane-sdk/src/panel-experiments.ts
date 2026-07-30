import type { AnalysisResultsEnvelope } from "@splitch/contracts";
import { AnalysisResultsEnvelopeSchema, ErrorResponseSchema } from "@splitch/contracts";
import type { ControlPlaneOperationResult } from "./operation-result";
import { parseControlPlaneResponse } from "./operation-result";
import {
  type PanelExperimentDetailInput,
  type PanelExperimentDetailOutput,
  parsePanelExperimentDetailOutput,
} from "./panel-experiment-detail";
import {
  type PanelExperimentResultsInput,
  type PanelExperimentResultsOutput,
  PanelExperimentResultsOutputSchema,
  parsePanelExperimentResultsOutput,
} from "./panel-experiment-results";

export type {
  PanelExperimentDetail,
  PanelExperimentDetailInput,
  PanelExperimentDetailOutput,
  PanelExperimentRun,
} from "./panel-experiment-detail";
export type {
  PanelExperimentResultsInput,
  PanelExperimentResultsOutput,
} from "./panel-experiment-results";
export { PanelExperimentResultsOutputSchema, parsePanelExperimentResultsOutput };

const PANEL_EXPERIMENTS_PATH = "/control-panel/experiments/list";
const PANEL_EXPERIMENT_DETAIL_PATH = "/control-panel/experiments/detail";
const PANEL_EXPERIMENT_RESULTS_PATH = "/control-panel/experiments/results";
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

/**
 * A refusal from the Analysis Worker, carried as a type rather than a string.
 *
 * `retryable` is the load-bearing field. A permanent integrity refusal that a
 * caller reports as "try again in 30s" teaches the caller to poll through a
 * fault that polling cannot clear (ADR-0036).
 */
export class ScopedAnalysisError extends Error {
  readonly status: number;
  /** The Analysis Worker's own error code, when it sent a typed body. */
  readonly code: string | null;
  readonly retryable: boolean;

  constructor(status: number, message: string, code: string | null = null) {
    super(message);
    this.name = "ScopedAnalysisError";
    this.status = status;
    this.code = code;
    // The typed body is the authority on whether waiting can help. Classifying
    // on the HTTP status alone would read a 500 carrying SERVICE_UNAVAILABLE as
    // a permanent fault, and a permanent integrity failure that happened to be
    // sent as a 503 as something worth polling.
    this.retryable = code === null ? TRANSIENT_STATUS.has(status) : TRANSIENT_CODES.has(code);
  }
}

const TRANSIENT_STATUS = new Set([429, 503]);
const TRANSIENT_CODES = new Set(["RATE_LIMITED", "SERVICE_UNAVAILABLE"]);

/**
 * Turns a refusal from the Analysis Worker into a typed error.
 *
 * The body is read before the status is trusted: the Worker states plainly
 * whether the condition is temporary, and discarding that to guess from a
 * three-digit code throws away the only reliable signal we were sent.
 */
async function scopedAnalysisFailure(response: Response): Promise<ScopedAnalysisError> {
  const parsed = ErrorResponseSchema.safeParse(await readJson(response));
  if (!parsed.success) {
    return new ScopedAnalysisError(
      response.status,
      `scoped analysis read failed with HTTP ${response.status}`,
    );
  }
  return new ScopedAnalysisError(response.status, parsed.data.message, parsed.data.code);
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export async function parseScopedAnalysisResults(
  response: Response,
  expectedRunId: string,
): Promise<AnalysisResultsEnvelope> {
  if (!response.ok) {
    throw await scopedAnalysisFailure(response);
  }
  const envelope = AnalysisResultsEnvelopeSchema.parse(await response.json());
  // Numbers from one Run rendered under another Run's heading is the exact
  // failure the no-pooling guarantee exists to prevent, and no amount of
  // retrying turns it into the right Run.
  if (envelope.run_id !== expectedRunId) {
    throw new ScopedAnalysisError(
      500,
      `scoped analysis answered for Run ${envelope.run_id}, not Run ${expectedRunId}`,
    );
  }
  return envelope;
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
