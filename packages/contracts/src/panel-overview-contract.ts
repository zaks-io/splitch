import { z } from "zod";
import { EnvironmentPolicySchema } from "./leaf-schemas-runtime";

/**
 * The App Overview read: one Environment's "what needs my attention" rollup.
 *
 * The Experiment section is a discriminated union rather than a list that can be
 * empty for two different reasons. An empty list means "nothing needs attention";
 * a failed Analysis read means "we do not know". Collapsing the second into the
 * first renders an outage as a clean bill of health, which is exactly the silent
 * fallback ADR-0036 forbids.
 */

export const overviewDecisionReasons = ["significance_reached", "horizon_reached"] as const;
export const OverviewDecisionReasonSchema = z.enum(overviewDecisionReasons);
export type OverviewDecisionReason = z.infer<typeof OverviewDecisionReasonSchema>;

export const overviewFailureReasons = [
  "srm_firing",
  "guardrail_breached",
  "multiple_assignment_quarantine",
] as const;
export const OverviewFailureReasonSchema = z.enum(overviewFailureReasons);
export type OverviewFailureReason = z.infer<typeof OverviewFailureReasonSchema>;

export const overviewExperimentsUnavailableReasons = [
  "analysis_unavailable",
  "experiment_integrity",
  "read_budget_exceeded",
] as const;
export const OverviewExperimentsUnavailableReasonSchema = z.enum(
  overviewExperimentsUnavailableReasons,
);
export type OverviewExperimentsUnavailableReason = z.infer<
  typeof OverviewExperimentsUnavailableReasonSchema
>;

const OverviewExperimentRefSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    runId: z.string().min(1),
  })
  .strict();

export const OverviewDecisionExperimentSchema = OverviewExperimentRefSchema.extend({
  reasons: z.array(OverviewDecisionReasonSchema).nonempty(),
}).strict();
export type OverviewDecisionExperiment = z.infer<typeof OverviewDecisionExperimentSchema>;

export const OverviewFailingExperimentSchema = OverviewExperimentRefSchema.extend({
  reasons: z.array(OverviewFailureReasonSchema).nonempty(),
}).strict();
export type OverviewFailingExperiment = z.infer<typeof OverviewFailingExperimentSchema>;

/**
 * `retryable` is carried on the wire rather than derived in each skin. A refusal
 * that tells an operator to retry something no retry can fix is its own failure
 * mode, so the Worker that knows which fault it hit is the one that decides.
 */
export const OverviewExperimentsSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("ok"),
      needingDecision: z.array(OverviewDecisionExperimentSchema),
      failing: z.array(OverviewFailingExperimentSchema),
    })
    .strict(),
  z
    .object({
      status: z.literal("unavailable"),
      reason: OverviewExperimentsUnavailableReasonSchema,
      retryable: z.boolean(),
    })
    .strict(),
]);
export type OverviewExperiments = z.infer<typeof OverviewExperimentsSchema>;

export const OverviewFlagConfigChangeSchema = z
  .object({
    flagId: z.string().min(1),
    flagKey: z.string().min(1),
    flagName: z.string().min(1),
    enabled: z.boolean(),
    updatedAt: z.string().min(1),
  })
  .strict();
export type OverviewFlagConfigChange = z.infer<typeof OverviewFlagConfigChangeSchema>;

export const AppOverviewResponseSchema = z
  .object({
    appId: z.string().min(1),
    environmentId: z.string().min(1),
    experiments: OverviewExperimentsSchema,
    flagConfiguration: z
      .object({
        recentlyChanged: z.array(OverviewFlagConfigChangeSchema),
        windowDays: z.number().int().positive(),
      })
      .strict(),
    environment: z
      .object({
        id: z.string().min(1),
        key: z.string().min(1),
        name: z.string().min(1),
        policy: EnvironmentPolicySchema,
      })
      .strict(),
  })
  .strict();
export type AppOverviewResponse = z.infer<typeof AppOverviewResponseSchema>;
