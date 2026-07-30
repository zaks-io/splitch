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
 *
 * `noData` carries the running Experiments whose Analysis result is absent: the
 * read succeeded and the answer is "not yet", which is neither attention nor a
 * clean bill of health. It is the same `no_data` state the Environment attention
 * rollup reports, and dropping those Experiments would let an unknown Run render
 * as calm (ADR-0036).
 */
export const OverviewExperimentsSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("ok"),
      needingDecision: z.array(OverviewDecisionExperimentSchema),
      failing: z.array(OverviewFailingExperimentSchema),
      noData: z.array(OverviewExperimentRefSchema),
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
    /**
     * Two separate bounds sit between "what changed in this Environment" and
     * "what this card shows", and both are reported rather than inferred, because
     * a capped list rendered as a complete one is the silent fallback ADR-0036
     * forbids.
     *
     * `changedCount` is how many changed Flag Configurations the Overview
     * OBSERVED inside the window. `recentlyChanged` holds only the newest few, so
     * `changedCount > recentlyChanged.length` means what follows is a head, not a
     * list. The display cap itself is not on the wire because it is not needed:
     * whenever it binds it equals `recentlyChanged.length`, and a skin that
     * reported a cap it did not actually apply would be stating a number it
     * cannot back.
     *
     * `readTruncated` says the bounded scan hit its own ceiling first: more than
     * `readLimit` changed, the Overview stopped counting there, and
     * `changedCount` is therefore a FLOOR rather than a total. Both bounds ride
     * on the wire because only the Worker that issued the read can observe them,
     * and their limits travel with them so a skin can state a ceiling without
     * holding its own copy of a server constant.
     */
    flagConfiguration: z
      .object({
        recentlyChanged: z.array(OverviewFlagConfigChangeSchema),
        windowDays: z.number().int().positive(),
        changedCount: z.number().int().nonnegative(),
        readTruncated: z.boolean(),
        readLimit: z.number().int().positive(),
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
