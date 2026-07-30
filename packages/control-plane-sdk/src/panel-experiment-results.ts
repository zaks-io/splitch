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

/**
 * The Results payload the Control Panel renders.
 *
 * `gate`, `srm` and `significance` are evaluated by the Worker, never by the
 * rendering surface: the Panel transports this verdict rather than recomputing
 * statistics (ADR-0030).
 */
export const PanelExperimentResultsOutputSchema = z
  .object({
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
  .strict();

export type PanelExperimentResultsOutput = z.infer<typeof PanelExperimentResultsOutputSchema>;

export function parsePanelExperimentResultsOutput(input: unknown) {
  const parsed = PanelExperimentResultsOutputSchema.safeParse(input);
  return parsed.success
    ? { success: true as const, data: parsed.data }
    : { success: false as const };
}
