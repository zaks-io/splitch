import { z } from "zod";
import { StoredFlagLifecycleClassSchema, VariantSchema } from "./leaf-schemas-flag";
import { PersistedDescriptionSchema, PersistedNameSchema } from "./persisted-field-limits";

/**
 * Flag removal brief and the optional code-removal claim on flags_delete.
 *
 * The brief is advisory: splitch never writes customer code and has no
 * repository evidence. The claim on delete is auditable, not proof.
 */

/** Caller-supplied claim that customer code no longer references the Flag. */
export const FlagCodeRemovalClaimSchema = z
  .object({
    reference: PersistedDescriptionSchema.min(1).describe(
      "URL or commit/PR ref the caller claims removed the Flag from code. Auditable claim, not proof.",
    ),
    state: z.literal("claimed"),
  })
  .strict();
export type FlagCodeRemovalClaim = z.infer<typeof FlagCodeRemovalClaimSchema>;

/**
 * What the deletion audit record stores. Omitted request input becomes an
 * explicit `unknown` state; never null-as-unknown.
 */
export const FlagCodeRemovalRecordSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("unknown") }).strict(),
  FlagCodeRemovalClaimSchema,
]);
export type FlagCodeRemovalRecord = z.infer<typeof FlagCodeRemovalRecordSchema>;

export const DeleteFlagRequestSchema = z
  .object({
    codeRemoval: FlagCodeRemovalClaimSchema.optional(),
  })
  .strict();
export type DeleteFlagRequest = z.infer<typeof DeleteFlagRequestSchema>;

const removalServingBlockers = [
  "live_experiment",
  "fractional_rollout",
  "multi_variant_targeting",
  "evaluation_rejected",
] as const;

export const FlagRemovalServingBlockerSchema = z.enum(removalServingBlockers);
export type FlagRemovalServingBlocker = z.infer<typeof FlagRemovalServingBlockerSchema>;

export const FlagRemovalEnvironmentServingSchema = z
  .object({
    environmentId: z.string().min(1),
    environmentKey: z.string().min(1),
    enabled: z.boolean(),
    /**
     * Configuration-derived Variant this Environment would keep when a single
     * Variant is determined. Null when configuration does not pin one. Not
     * runtime telemetry.
     */
    configurationServedVariant: PersistedNameSchema.nullable(),
    servingEvidence: z.literal("configuration_unverified"),
    blockers: z.array(FlagRemovalServingBlockerSchema),
    /** Set when evaluation-core rejects the Configuration; null otherwise. */
    evaluationError: z.string().min(1).nullable(),
  })
  .strict();
export type FlagRemovalEnvironmentServing = z.infer<typeof FlagRemovalEnvironmentServingSchema>;

export const FlagRemovalBriefResponseSchema = z
  .object({
    flagId: z.string().min(1),
    flagKey: z.string().min(1),
    variants: z.array(VariantSchema.pick({ id: true, name: true, value: true }).strict()),
    lifecycleClass: StoredFlagLifecycleClassSchema,
    owner: z.string().nullable(),
    expiresAt: z.string().nullable(),
    environments: z.array(FlagRemovalEnvironmentServingSchema),
    uniformAcrossEnvironments: z.boolean(),
    /** Variant to keep in customer code when removal is configuration-safe. */
    keepVariant: PersistedNameSchema.nullable(),
    removalSafe: z.boolean(),
    removalBlockers: z.array(z.string().min(1)),
    /** Real SDK / OpenFeature call shapes from packages/sdk, with this Flag key. */
    sdkCallShapes: z.array(z.string().min(1)),
    caveats: z.array(z.string().min(1)),
  })
  .strict();
export type FlagRemovalBriefResponse = z.infer<typeof FlagRemovalBriefResponseSchema>;

/** Fixed caveats every brief carries so agents do not invent proof. */
export const FLAG_REMOVAL_BRIEF_CAVEATS = [
  "splitch never writes customer code.",
  "This brief has no repository evidence; sdkCallShapes are search hints only.",
  "Environment servings are derived from Flag Configuration, not runtime telemetry (servingEvidence is configuration_unverified).",
] as const;
