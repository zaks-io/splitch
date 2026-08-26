export const INGEST_STREAMS = [
  "raw_evaluations",
  "raw_events",
  "metric_events",
  "web_events",
] as const;

export type IngestStream = (typeof INGEST_STREAMS)[number];

export type IngestAdmissionBudget = {
  readonly rowsPerSecond: number;
  readonly rowBurstCapacity: number;
  readonly bytesPerSecond: number;
  readonly byteBurstCapacity: number;
};

/**
 * Platform-owned launch profile from ADR-0043 / the edge-ingest contract.
 * A missing stream or value fails closed; there is no customer override.
 */
export const INGEST_ADMISSION_LAUNCH_PROFILE: Record<IngestStream, IngestAdmissionBudget> = {
  raw_evaluations: {
    rowsPerSecond: 250,
    rowBurstCapacity: 2_500,
    bytesPerSecond: 262_144,
    byteBurstCapacity: 2_621_440,
  },
  raw_events: {
    rowsPerSecond: 300,
    rowBurstCapacity: 3_000,
    bytesPerSecond: 524_288,
    byteBurstCapacity: 5_242_880,
  },
  metric_events: {
    rowsPerSecond: 100,
    rowBurstCapacity: 1_000,
    bytesPerSecond: 524_288,
    byteBurstCapacity: 5_242_880,
  },
  web_events: {
    rowsPerSecond: 500,
    rowBurstCapacity: 5_000,
    bytesPerSecond: 1_048_576,
    byteBurstCapacity: 10_485_760,
  },
};

export function ingestAdmissionScopeName(
  appId: string,
  environmentId: string,
  ingestStream: IngestStream,
): string {
  return JSON.stringify([appId, environmentId, ingestStream]);
}

export function ingestAdmissionBudget(ingestStream: IngestStream): IngestAdmissionBudget {
  const budget = INGEST_ADMISSION_LAUNCH_PROFILE[ingestStream];
  if (!isCompleteBudget(budget)) {
    throw new Error(`Ingest Admission Gate has no launch budget for ${ingestStream}`);
  }
  return budget;
}

function isCompleteBudget(
  budget: IngestAdmissionBudget | undefined,
): budget is IngestAdmissionBudget {
  return (
    budget !== undefined &&
    isPositive(budget.rowsPerSecond) &&
    isPositive(budget.rowBurstCapacity) &&
    isPositive(budget.bytesPerSecond) &&
    isPositive(budget.byteBurstCapacity)
  );
}

function isPositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}
