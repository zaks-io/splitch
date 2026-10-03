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

export const StaleFlagItemSchema = z
  .object({
    flag: FlagResponseSchema,
    reasons: z.array(StaleFlagReasonSchema).min(1),
    /** Ordinary Flag reads record no served Variant; never claim unused. */
    servingEvidence: z.literal(SERVING_EVIDENCE_UNVERIFIED),
  })
  .strict();
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
  })
  .strict();

/**
 * Per-App inventory health (plan 3.8). Additions and removals both come from the
 * Flag change log (`action=created|deleted`, `target_type=flag`) so a hard
 * delete does not rewrite prior months. `historyCoverageStartsAt` is the
 * earliest log instant for the App (null when the App has no log rows yet);
 * Flags that predate migration 0026 have no create event and are outside that
 * window rather than silently zeroed.
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
        /** Earliest `flag_change_events.changedAt` for the App; null = no log yet. */
        historyCoverageStartsAt: z.string().nullable(),
      })
      .strict(),
    expiredButLiveCount: z.number().int().nonnegative(),
  })
  .strict();
export type FlagInventoryHealthResponse = z.infer<typeof FlagInventoryHealthResponseSchema>;
