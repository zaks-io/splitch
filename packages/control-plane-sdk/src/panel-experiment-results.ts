import {
  ExperimentDecisionGateSchema,
  ExperimentSignificanceDisplaysSchema,
  ExperimentSrmDiagnosticsSchema,
  FrozenControlIdentitySchema,
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
export const PanelExperimentResultsOutputSchema = z.discriminatedUnion("state", [
  z
    .object({
      state: z.literal("ready"),
      runId: z.string().min(1),
      runNumber: z.number().int().min(1),
      runStatus: z.enum(["running", "ended"]),
      /**
       * The baseline every lift in `stats` is measured against, resolved from what
       * the Run froze. `unresolvable` is a real state: a Run backfilled by SPL-184
       * may carry a Control that is absent from its own frozen Variant set, and no
       * arm may be substituted for it.
       */
      control: FrozenControlIdentitySchema,
      stats: StatsOutputSchema,
      srm: ExperimentSrmDiagnosticsSchema,
      gate: ExperimentDecisionGateSchema,
      /** Per-arm significance claim, keyed by `metric_id/variant`. */
      significance: ExperimentSignificanceDisplaysSchema,
    })
    .strict(),
  z
    .object({
      state: z.literal("no_data"),
      runId: z.string().min(1),
      runNumber: z.number().int().min(1),
      runStatus: z.enum(["running", "ended"]),
      control: FrozenControlIdentitySchema,
      missing: PanelResultsMissingInputSchema,
    })
    .strict(),
  z
    .object({
      state: z.literal("no_run"),
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
  const parsed = PanelExperimentResultsOutputSchema.safeParse(input);
  return parsed.success
    ? { success: true as const, data: parsed.data }
    : { success: false as const };
}
