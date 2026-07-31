import { z } from "zod";

/**
 * The wire contract of the Flag Configuration server functions.
 *
 * These schemas are the ONLY thing between an unauthenticated HTTP caller and the
 * Control Plane client: a server function is a public endpoint, so every field is
 * validated here rather than trusted from the component that normally calls it.
 * They live in their own module so each defense is directly assertable — a
 * `.strict()` nobody tests is a `.strict()` that can be relaxed without a failing
 * build.
 */

const FlagScopeSchema = z.object({
  appId: z.string().min(1),
  environmentId: z.string().min(1),
  flagId: z.string().min(1),
});

/**
 * Carried from the browser, never minted per handler invocation: a key minted here
 * would be fresh on every retry, leaving the Control Plane no way to recognize a
 * replay of the same submission. Empty is therefore not a key.
 */
const IdempotencyKeySchema = z.string().min(1);

/** Variant id -> name, so the gate can name what a rule serves. */
const VariantLabelsSchema = z.record(z.string(), z.string()).optional();

export const ConfigPatchSchema = z
  .object({
    enabled: z.boolean().optional(),
    availableVariantNames: z.array(z.string()).optional(),
    // Percentage only. The bucketing salt is minted server-side and never
    // regenerated, so the operator neither sees nor sets it — `.strict()` is what
    // rejects a caller-supplied one instead of forwarding it.
    rollout: z
      .object({ percentage: z.number().min(0).max(100) })
      .strict()
      .nullable()
      .optional(),
  })
  .strict();

export const UpdateConfigInputSchema = FlagScopeSchema.extend({
  patch: ConfigPatchSchema,
  idempotencyKey: IdempotencyKeySchema,
  variantLabels: VariantLabelsSchema,
});

export const TargetingEditSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("remove"), ruleId: z.string().min(1) }).strict(),
  z
    .object({
      kind: z.literal("add"),
      ruleId: z.string().min(1),
      attribute: z.string().min(1),
      operator: z.literal("eq"),
      value: z.string().min(1),
      variantId: z.string().min(1),
    })
    .strict(),
]);

export const TargetingEditInputSchema = FlagScopeSchema.extend({
  edit: TargetingEditSchema,
  idempotencyKey: IdempotencyKeySchema,
  variantLabels: VariantLabelsSchema,
});

/**
 * The promote endpoint's field-group selection (ADR-0028), revalidated here.
 *
 * `.strict()` and the `literal(true)` ticks are the contract, not decoration: the
 * three whole-group fields have exactly one meaningful value, so a `false` is a
 * caller asking for something the endpoint does not mean and is refused rather
 * than coerced. Absence — not `false` — is how a group is left untouched.
 */
const PromotionSelectSchema = z
  .object({
    availability: z.array(z.string().min(1)).min(1).optional(),
    targeting: z.literal(true).optional(),
    rollout: z.literal(true).optional(),
    enabled: z.literal(true).optional(),
  })
  .strict();

export const PromoteInputSchema = z
  .object({
    appId: z.string().min(1),
    /** The Environment about to change; ITS Policy governs this write. */
    targetEnvironmentId: z.string().min(1),
    fromEnvironmentId: z.string().min(1),
    flagId: z.string().min(1),
    select: PromotionSelectSchema,
    idempotencyKey: IdempotencyKeySchema,
    variantLabels: VariantLabelsSchema,
  })
  // An empty selection is a Promotion that promotes nothing. The endpoint would
  // accept it as a no-op, which reports success for a change that never happened.
  .refine((input) => Object.keys(input.select).length > 0, {
    message: "Select at least one field group to promote",
    path: ["select"],
  })
  // Promotion is a pull into the target from somewhere else; the same Environment
  // on both sides is a diff against itself that can only ever be empty.
  .refine((input) => input.fromEnvironmentId !== input.targetEnvironmentId, {
    message: "The source and target Environments must differ",
    path: ["fromEnvironmentId"],
  });

export const ApprovalRequestInputSchema = z.object({
  appId: z.string().min(1),
  approvalRequestId: z.string().min(1),
  variantLabels: VariantLabelsSchema,
});

export const ReviewInputSchema = ApprovalRequestInputSchema.extend({
  action: z.enum(["approve_and_apply", "decline"]),
  idempotencyKey: IdempotencyKeySchema,
});
