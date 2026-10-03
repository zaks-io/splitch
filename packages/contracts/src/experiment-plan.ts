import { z } from "@hono/zod-openapi";
import { PERSISTED_RECORD_MAX_KEYS } from "./persisted-field-limits";

/**
 * Wire shapes for the read-only experiment_plan operation. The pure planner
 * lives in @splitch/stats; this file is the Control Plane / CLI / MCP contract.
 *
 * Cold start: callers must supply baseline mean/variance (or rate). This slice
 * does not read historical baselines; baselineSource is always "caller".
 *
 * Arm cap matches Experiment allocation's persisted record key limit (Variant
 * names in the draft allocation), which is the create-time arm bound.
 *
 * Input floors below keep derived outputs representable: daily traffic so
 * expectedDurationDays stays in the safe-integer range for realistic n, and
 * non-zero continuous |baselineMean| so mdeRelative cannot overflow to
 * Infinity. Alpha is bounded below so inverse-normal critical values stay in
 * the supported probability range (alpha/2 does not underflow past the
 * inverseNormalCdf domain in practice).
 */
export const EXPERIMENT_PLAN_MAX_ARM_COUNT = PERSISTED_RECORD_MAX_KEYS;

/** Minimum expectedDailyEligibleEntities on the wire (positive, but not tiny). */
export const EXPERIMENT_PLAN_MIN_DAILY_ELIGIBLE_ENTITIES = 1e-6;

/**
 * Non-zero continuous baselineMean must have at least this absolute magnitude
 * so mdeAbsolute / |mean| stays finite under IEEE doubles.
 */
export const EXPERIMENT_PLAN_MIN_BASELINE_MEAN_ABS = 1e-100;

/** Smallest alpha the planner math supports (inverse-normal critical values). */
export const EXPERIMENT_PLAN_MIN_ALPHA = 1e-10;

type PlanRequestValue = {
  metricKind: "continuous" | "binomial";
  baselineMean?: number;
  baselineVariance?: number;
  baselineRate?: number;
  mdeAbsolute?: number;
  mdeRelative?: number;
  fixedSampleSizePerArm?: number;
  armCount: number;
  trafficSplit?: number[];
  guardrailBreachAbsolute?: number;
  guardrailBreachRelative?: number;
};

function refineBaseline(value: PlanRequestValue, ctx: z.RefinementCtx): void {
  if (value.metricKind === "continuous") {
    if (value.baselineMean === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["baselineMean"],
        message: "baselineMean is required for continuous Metrics.",
      });
    } else if (
      value.baselineMean !== 0 &&
      !(Math.abs(value.baselineMean) >= EXPERIMENT_PLAN_MIN_BASELINE_MEAN_ABS)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["baselineMean"],
        message: `Non-zero baselineMean absolute magnitude must be at least ${EXPERIMENT_PLAN_MIN_BASELINE_MEAN_ABS} so derived mdeRelative stays finite.`,
      });
    }
    if (value.baselineVariance === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["baselineVariance"],
        message: "baselineVariance is required for continuous Metrics.",
      });
    }
    return;
  }
  if (value.baselineRate === undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["baselineRate"],
      message: "baselineRate is required for binomial Metrics.",
    });
  }
}

function refineObjective(value: PlanRequestValue, ctx: z.RefinementCtx): void {
  const hasAbs = value.mdeAbsolute !== undefined;
  const hasRel = value.mdeRelative !== undefined;
  const hasFixed = value.fixedSampleSizePerArm !== undefined;
  if (hasAbs && hasRel) {
    ctx.addIssue({
      code: "custom",
      path: ["mdeAbsolute"],
      message: "Provide mdeAbsolute or mdeRelative, not both.",
    });
  }
  if ((hasAbs || hasRel) === hasFixed) {
    ctx.addIssue({
      code: "custom",
      path: hasFixed ? ["fixedSampleSizePerArm"] : ["mdeAbsolute"],
      message:
        "Provide exactly one of: mdeAbsolute, mdeRelative, or fixedSampleSizePerArm. Observed effects are not accepted.",
    });
  }
}

function refineGuardrailAndSplit(value: PlanRequestValue, ctx: z.RefinementCtx): void {
  if (value.guardrailBreachAbsolute !== undefined && value.guardrailBreachRelative !== undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["guardrailBreachAbsolute"],
      message: "Provide guardrailBreachAbsolute or guardrailBreachRelative, not both.",
    });
  }
  if (value.trafficSplit === undefined) return;
  if (value.trafficSplit.length !== value.armCount) {
    ctx.addIssue({
      code: "custom",
      path: ["trafficSplit"],
      message: `trafficSplit length must equal armCount (${value.armCount}).`,
    });
  }
  const sum = value.trafficSplit.reduce((acc, share) => acc + share, 0);
  if (Math.abs(sum - 1) > 1e-9) {
    ctx.addIssue({
      code: "custom",
      path: ["trafficSplit"],
      message: `trafficSplit shares must sum to 1 (got ${sum}).`,
    });
  }
}

export const ExperimentPlanRequestSchema = z
  .object({
    metricKind: z.enum(["continuous", "binomial"]),
    baselineMean: z.number().finite().optional(),
    baselineVariance: z.number().finite().positive().optional(),
    baselineRate: z.number().gt(0).lt(1).optional(),
    // Floor keeps inverse-normal critical values in the supported domain.
    alpha: z.number().gte(EXPERIMENT_PLAN_MIN_ALPHA).lt(1).optional(),
    power: z.number().gt(0).lt(1).optional(),
    mdeAbsolute: z.number().finite().positive().optional(),
    mdeRelative: z.number().finite().positive().optional(),
    fixedSampleSizePerArm: z.number().int().positive().optional(),
    armCount: z.number().int().min(2).max(EXPERIMENT_PLAN_MAX_ARM_COUNT),
    trafficSplit: z
      .array(z.number().finite().positive())
      .min(2)
      .max(EXPERIMENT_PLAN_MAX_ARM_COUNT)
      .optional(),
    // Floor keeps expectedDurationDays representable for realistic sample sizes.
    expectedDailyEligibleEntities: z
      .number()
      .finite()
      .gte(EXPERIMENT_PLAN_MIN_DAILY_ELIGIBLE_ENTITIES),
    guardrailBreachAbsolute: z.number().finite().positive().optional(),
    guardrailBreachRelative: z.number().finite().positive().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    refineBaseline(value, ctx);
    refineObjective(value, ctx);
    refineGuardrailAndSplit(value, ctx);
  });

export type ExperimentPlanRequest = z.infer<typeof ExperimentPlanRequestSchema>;

export const ExperimentPlanResponseSchema = z
  .object({
    fixedHorizonNPerArm: z.number().int().positive(),
    alwaysValidInflation: z.number().finite().positive(),
    nPerArm: z.array(z.number().int().positive()).min(2),
    /** Pass to experiments_start as targetN. */
    targetN: z.number().int().positive(),
    expectedDurationDays: z.number().int().positive(),
    mdeAbsolute: z.number().finite().positive(),
    mdeRelative: z.number().finite().positive().nullable(),
    alpha: z.number().gt(0).lt(1),
    power: z.number().gt(0).lt(1),
    comparisonPowers: z.array(z.number().gte(0).lte(1)).min(1),
    guardrailPower: z.number().gte(0).lte(1).nullable(),
    baselineMean: z.number().finite(),
    baselineVariance: z.number().finite().positive(),
    baselineSource: z.enum(["caller", "history"]),
    mode: z.enum(["size_from_mde", "mde_from_size"]),
  })
  .strict();

export type ExperimentPlanResponse = z.infer<typeof ExperimentPlanResponseSchema>;
