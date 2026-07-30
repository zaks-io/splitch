import {
  ExperimentDecisionGateSchema,
  ExperimentSrmDiagnosticsSchema,
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

/**
 * The Results payload the Control Panel renders.
 *
 * `gate` and `srm` are evaluated by the Worker, never by the rendering surface:
 * the Panel transports this refusal rather than recomputing statistics.
 */
export const PanelExperimentResultsOutputSchema = z
  .object({
    runId: z.string().min(1),
    runNumber: z.number().int().min(1),
    runStatus: z.enum(["running", "ended"]),
    /** The baseline Variant every lift in `stats` is measured against. */
    controlVariant: z.string().min(1),
    stats: StatsOutputSchema,
    srm: ExperimentSrmDiagnosticsSchema,
    gate: ExperimentDecisionGateSchema,
  })
  .strict();

export type PanelExperimentResultsOutput = z.infer<typeof PanelExperimentResultsOutputSchema>;

export function parsePanelExperimentResultsOutput(input: unknown) {
  const parsed = PanelExperimentResultsOutputSchema.safeParse(input);
  return parsed.success
    ? { success: true as const, data: parsed.data }
    : { success: false as const };
}
