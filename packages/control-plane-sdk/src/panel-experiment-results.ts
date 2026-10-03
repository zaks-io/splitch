import {
  DecisionGateCheckIdSchema,
  ExperimentDecisionGateSchema,
  ExperimentResultsReadinessSchema,
  ExperimentSignificanceDisplaysSchema,
  ExperimentSrmDiagnosticsSchema,
  FrozenControlIdentitySchema,
  RecommendationUnavailableReasonSchema,
  ShipRecommendationSchema,
  StatsOutputSchema,
} from "@splitch/contracts";
import { z } from "zod";

export interface PanelExperimentResultsInput {
  appId: string;
  environmentId: string;
  experimentId: string;
  /** Omitted reads the Experiment's most recent Run. Runs are never pooled (ADR-0006). */
  runId?: string;
}

/** Same missing-input names Analysis answers with on `state: "no_data"`. */
const PanelResultsMissingInputSchema = z.enum(["exposures", "metric_events"]);

/** Shared producer readiness fields; Panel renders them and never re-derives. */
const producerReadinessFields = {
  readiness: ExperimentResultsReadinessSchema,
  blockedBy: z.array(DecisionGateCheckIdSchema),
  reasons: z.array(z.string()),
} as const;

const producerRecommendationFields = {
  recommendation: ShipRecommendationSchema.optional(),
  recommendationUnavailable: RecommendationUnavailableReasonSchema.optional(),
} as const;

/**
 * The Results payload the Control Panel renders.
 *
 * `state` mirrors Analysis / attention-rollup: `no_data` is a healthy early-Run
 * collecting state (not an error page). `ready` carries the Worker-evaluated
 * gate, srm, and significance so the Panel never recomputes statistics
 * (ADR-0030). `no_run` is a draft Experiment with no Run yet (SPL-305): it
 * cannot carry `runId` / `runStatus` without inventing a placeholder, so it is
 * a separate union member and names Start as the next step.
 */
const readyFields = {
  state: z.literal("ready"),
  runId: z.string().min(1),
  runNumber: z.number().int().min(1),
  runStatus: z.enum(["running", "ended"]),
  /**
   * The frozen Run Control identity and its integrity against the Run Snapshot.
   * `unresolvable` means no baseline can be identified; `disagreement` keeps
   * the frozen Control identity visible beside the arm the Analysis measured against.
   */
  control: FrozenControlIdentitySchema,
  ...producerReadinessFields,
  ...producerRecommendationFields,
  stats: StatsOutputSchema,
  srm: ExperimentSrmDiagnosticsSchema,
  gate: ExperimentDecisionGateSchema,
  /** Per-arm significance claim, keyed by `metric_id/variant`. */
  significance: ExperimentSignificanceDisplaysSchema,
} as const;

const PanelExperimentResultsReadySchema = z.union([
  z
    .object({
      ...readyFields,
      dataWatermark: z.string().datetime({ offset: true }),
      resultToken: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    })
    .strict(),
  z
    .object({
      ...readyFields,
      dataWatermark: z.never().optional(),
      resultToken: z.never().optional(),
    })
    .strict(),
]);

export const PanelExperimentResultsOutputSchema = z.union([
  PanelExperimentResultsReadySchema,
  z
    .object({
      state: z.literal("no_data"),
      runId: z.string().min(1),
      runNumber: z.number().int().min(1),
      runStatus: z.enum(["running", "ended"]),
      control: FrozenControlIdentitySchema,
      ...producerReadinessFields,
      missing: PanelResultsMissingInputSchema,
    })
    .strict(),
  z
    .object({
      state: z.literal("no_run"),
      ...producerReadinessFields,
      recommendedAction: z.literal("START_A_RUN"),
    })
    .strict(),
]);

export type PanelExperimentResultsOutput = z.infer<typeof PanelExperimentResultsOutputSchema>;
export type PanelExperimentResultsReady = Extract<PanelExperimentResultsOutput, { state: "ready" }>;
export type PanelExperimentResultsNoData = Extract<
  PanelExperimentResultsOutput,
  { state: "no_data" }
>;
export type PanelExperimentResultsNoRun = Extract<
  PanelExperimentResultsOutput,
  { state: "no_run" }
>;

export function parsePanelExperimentResultsOutput(input: unknown) {
  // Preserve Zod issues so parseResponseTolerantly can drop additive keys while
  // still failing loud on wrong types / missing required fields.
  return PanelExperimentResultsOutputSchema.safeParse(input);
}
