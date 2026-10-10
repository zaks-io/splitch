import type { PlannedDurationEvidence } from "@splitch/stats";

export interface RunDurationRow {
  startedAt: string;
  plannedDurationDays: number | null;
  plannedDurationOverrideReason: string | null;
}

/**
 * The planned-duration gate input from the D1 Run, the authority for what the
 * Run committed to at Start, and the watermark of the evidence being judged.
 */
export function runDurationEvidence(
  run: RunDurationRow,
  dataWatermark: string | undefined,
): PlannedDurationEvidence {
  return {
    plannedDurationDays: run.plannedDurationDays,
    overrideReason: run.plannedDurationOverrideReason,
    runStartedAt: run.startedAt,
    dataWatermark: dataWatermark ?? null,
  };
}
