import type { MetricKind } from "@splitch/contracts";
import type { MetricRow } from "./metric-segment-shared";

/**
 * The per-Metric analysis knobs: the guardrail bound (result-contracts.md) and
 * the variance-reduction rule (variance-reduction.md). `null` means "no
 * preference, engine default applies" — it is NOT a value the engine reads.
 * Start resolves every null into the explicit default and freezes the answer on
 * the Run, so editing a Metric mid-Run cannot move an already-decided result.
 */
export interface MetricAnalysisConfig {
  downsideThresholdPct: number | null;
  winsorize: boolean | null;
  winsorizePct: number | null;
  cuped: boolean | null;
  cupedCoverageThresholdPct: number | null;
}

const FIELDS = [
  "downsideThresholdPct",
  "winsorize",
  "winsorizePct",
  "cuped",
  "cupedCoverageThresholdPct",
] as const satisfies readonly (keyof MetricAnalysisConfig)[];

/**
 * Patch semantics: an omitted field is unchanged, an explicit `null` returns the
 * Metric to the engine default. Ranges are enforced by the route schema.
 */
export function metricAnalysisConfig(
  body: Record<string, unknown>,
  current: MetricRow | null,
): MetricAnalysisConfig {
  const resolve = <K extends keyof MetricAnalysisConfig>(field: K): MetricAnalysisConfig[K] =>
    body[field] !== undefined
      ? (body[field] as MetricAnalysisConfig[K])
      : ((current?.[field] ?? null) as MetricAnalysisConfig[K]);
  return {
    downsideThresholdPct: resolve("downsideThresholdPct"),
    winsorize: resolve("winsorize"),
    winsorizePct: resolve("winsorizePct"),
    cuped: resolve("cuped"),
    cupedCoverageThresholdPct: resolve("cupedCoverageThresholdPct"),
  };
}

/**
 * Winsorization is never applied to a binomial Metric: 0/1 has no tail to cap
 * (variance-reduction.md). Accepting the knob would store a cap rule the engine
 * ignores and then report it back as if it were in force.
 */
export function metricAnalysisIssue(
  kind: MetricKind,
  config: MetricAnalysisConfig,
): { field: string; message: string } | null {
  if (kind !== "binomial") return null;
  for (const field of ["winsorize", "winsorizePct"] as const) {
    if (config[field] !== null) {
      return { field, message: `binomial Metric cannot set ${field}; 0/1 values have no tail` };
    }
  }
  return null;
}

export function metricAnalysisPatch(
  body: Record<string, unknown>,
  config: MetricAnalysisConfig,
): Partial<MetricAnalysisConfig> {
  const patch: Partial<MetricAnalysisConfig> = {};
  for (const field of FIELDS) {
    if (body[field] !== undefined) Object.assign(patch, { [field]: config[field] });
  }
  return patch;
}
