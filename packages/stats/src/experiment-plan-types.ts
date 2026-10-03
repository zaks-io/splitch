export type ExperimentPlanBaselineSource = "caller" | "history";

export type ExperimentPlanMetricKind = "binomial" | "continuous";

export interface ExperimentPlanInput {
  readonly metricKind: ExperimentPlanMetricKind;
  /** Required for continuous Metrics. Refused when missing. */
  readonly baselineMean?: number;
  /** Required for continuous Metrics. Refused when missing. */
  readonly baselineVariance?: number;
  /** Required for binomial Metrics (rate in (0, 1)). Refused when missing. */
  readonly baselineRate?: number;
  readonly alpha?: number;
  readonly power?: number;
  /** Absolute MDE on the absolute-lift scale. Mutually exclusive with mdeRelative and fixedSampleSizePerArm. */
  readonly mdeAbsolute?: number;
  /** Relative MDE as a fraction of baseline mean/rate. Mutually exclusive with mdeAbsolute and fixedSampleSizePerArm. */
  readonly mdeRelative?: number;
  /** When set, solve for the MDE detectable at this Entities-per-arm size (equal split reference). */
  readonly fixedSampleSizePerArm?: number;
  readonly armCount: number;
  /** Traffic shares, length armCount, positive, sum to 1. Default: equal. Index 0 is Control. */
  readonly trafficSplit?: readonly number[];
  readonly expectedDailyEligibleEntities: number;
  readonly guardrailBreachAbsolute?: number;
  readonly guardrailBreachRelative?: number;
}

export interface ExperimentPlanIssue {
  readonly path: readonly string[];
  readonly message: string;
}

export interface ExperimentPlanResult {
  readonly fixedHorizonNPerArm: number;
  readonly alwaysValidInflation: number;
  readonly nPerArm: readonly number[];
  /** Pass to Start as targetN: Control + primary treatment Entities under the always-valid plan. */
  readonly targetN: number;
  readonly expectedDurationDays: number;
  readonly mdeAbsolute: number;
  readonly mdeRelative: number | null;
  readonly alpha: number;
  readonly power: number;
  readonly guardrailPower: number | null;
  readonly baselineMean: number;
  readonly baselineVariance: number;
  readonly baselineSource: ExperimentPlanBaselineSource;
  readonly mode: "size_from_mde" | "mde_from_size";
}

export type ExperimentPlanOutcome =
  | { readonly ok: true; readonly plan: ExperimentPlanResult }
  | { readonly ok: false; readonly issues: readonly ExperimentPlanIssue[] };
