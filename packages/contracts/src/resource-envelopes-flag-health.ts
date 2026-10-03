import { z } from "@hono/zod-openapi";
import { SERVING_EVIDENCE_UNVERIFIED } from "./flag-stale-detect";
import { FLAG_AGE_BUCKETS } from "./flag-stale-thresholds";
import { StoredFlagLifecycleClassSchema } from "./leaf-schemas-flag";
import { FlagResponseSchema } from "./resource-envelopes-flag";
import { listResponse } from "./wire-envelopes-core";

const UniformServingModeSchema = z.enum(["disabled", "default_only", "full_rollout"]);

const UniformEnvironmentEvidenceSchema = z
  .object({
    environmentId: z.string(),
    mode: UniformServingModeSchema,
    updatedAt: z.string(),
  })
  .strict();

/**
 * One typed stale reason with its evidence. Additive discriminated union: new
 * `kind` members can land later without renaming existing fields.
 */
export const StaleFlagReasonSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("uniform_serving"),
      thresholdDays: z.number().int().positive(),
      uniformSince: z.string(),
      environments: z.array(UniformEnvironmentEvidenceSchema).min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("past_expiry"),
      expiresAt: z.string(),
      lifecycleClass: StoredFlagLifecycleClassSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("unchanged"),
      thresholdDays: z.number().int().positive(),
      lastChangedAt: z.string(),
      source: z.enum(["flag_change_log", "flag_updated_at"]),
    })
    .strict(),
]);
export type StaleFlagReason = z.infer<typeof StaleFlagReasonSchema>;

/**
 * App-scoped uniform-serving history. Legacy Runs with no Start change-log row
 * make attribution unknown; the detector must not treat missing Run history as
 * "no Run history".
 */
export const UniformServingSignalSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("available") }).strict(),
  z
    .object({
      state: z.literal("unknown"),
      reason: z.literal("run_history_unavailable"),
    })
    .strict(),
]);

/**
 * A stale item either has at least one definite reason, or carries unknown
 * uniform-serving history (so a legacy-Run App does not silently drop Flags
 * that would have looked uniform from Configuration alone).
 */
export const StaleFlagItemSchema = z.union([
  z
    .object({
      flag: FlagResponseSchema,
      reasons: z.array(StaleFlagReasonSchema).min(1),
      servingEvidence: z.literal(SERVING_EVIDENCE_UNVERIFIED),
      uniformServing: z.object({ state: z.literal("available") }).strict(),
    })
    .strict(),
  z
    .object({
      flag: FlagResponseSchema,
      reasons: z.array(StaleFlagReasonSchema),
      servingEvidence: z.literal(SERVING_EVIDENCE_UNVERIFIED),
      uniformServing: z
        .object({
          state: z.literal("unknown"),
          reason: z.literal("run_history_unavailable"),
        })
        .strict(),
    })
    .strict(),
]);
export type StaleFlagItem = z.infer<typeof StaleFlagItemSchema>;

export const StaleFlagListResponseSchema = listResponse(StaleFlagItemSchema);
export type StaleFlagListResponse = z.infer<typeof StaleFlagListResponseSchema>;

const LifecycleClassCountsSchema = z
  .object({
    release: z.number().int().nonnegative(),
    experiment: z.number().int().nonnegative(),
    ops: z.number().int().nonnegative(),
    permission: z.number().int().nonnegative(),
    unclassified: z.number().int().nonnegative(),
  })
  .strict();

const AgeBucketCountSchema = z
  .object({
    bucket: z.enum(FLAG_AGE_BUCKETS),
    count: z.number().int().nonnegative(),
  })
  .strict();

const MonthChurnSchema = z
  .object({
    month: z.string().regex(/^\d{4}-\d{2}$/),
    added: z.number().int().nonnegative(),
    removed: z.number().int().nonnegative(),
    /**
     * `complete` only when the UTC month start is at or after
     * `historyCoverageStartsAt`; otherwise counts may miss pruned rows.
     */
    coverage: z.enum(["complete", "partial"]),
  })
  .strict();

/**
 * Per-App inventory health (plan 3.8). Additions and removals both come from the
 * Flag change log (`action=created|deleted`, `target_type=flag`) so a hard
 * delete does not rewrite prior months. `historyCoverageStartsAt` is the later
 * of the earliest surviving log instant and the retention floor (same 90-day
 * window the pruning cron uses); null when the App has no log rows yet. Months
 * that start before that instant are labeled `coverage: "partial"`.
 */
export const FlagInventoryHealthResponseSchema = z
  .object({
    appId: z.string(),
    asOf: z.string(),
    countsByLifecycleClass: LifecycleClassCountsSchema,
    ageDistribution: z.array(AgeBucketCountSchema).length(FLAG_AGE_BUCKETS.length),
    monthlyChurn: z
      .object({
        months: z.array(MonthChurnSchema),
        additionsSource: z.literal("flag_change_log"),
        removalsSource: z.literal("flag_change_log"),
        /**
         * Later of earliest surviving `changedAt` and retention floor; null =
         * no log yet.
         */
        historyCoverageStartsAt: z.string().nullable(),
      })
      .strict(),
    expiredButLiveCount: z.number().int().nonnegative(),
  })
  .strict();
export type FlagInventoryHealthResponse = z.infer<typeof FlagInventoryHealthResponseSchema>;
