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

export const ApprovalRequestInputSchema = z.object({
  appId: z.string().min(1),
  approvalRequestId: z.string().min(1),
  variantLabels: VariantLabelsSchema,
});

export const ReviewInputSchema = ApprovalRequestInputSchema.extend({
  action: z.enum(["approve_and_apply", "decline"]),
  idempotencyKey: IdempotencyKeySchema,
});
