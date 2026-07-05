import { z } from "zod";
import { ErrorCodeSchema } from "./errors";

/**
 * Minimal data-plane contract surface for the public `@splitch/sdk` bundle.
 *
 * Canonical definitions live in `leaf-schemas-runtime.ts` and
 * `wire-envelopes-core.ts`. This module intentionally omits control-plane,
 * identity, credential, and test-evaluation schemas so the published SDK
 * cannot ship private internals.
 */

export const resolutionReasons = [
  "SPLIT",
  "TARGETING_MATCH",
  "DEFAULT",
  "DISABLED",
  "CACHED",
  "STALE",
  "ERROR",
] as const;

export const ResolutionReasonSchema = z.enum(resolutionReasons);
export type ResolutionReason = z.infer<typeof ResolutionReasonSchema>;

export const VariantValueSchema = z.union([
  z.boolean(),
  z.string(),
  z.number(),
  z.record(z.string(), z.unknown()),
]);
export type VariantValue = z.infer<typeof VariantValueSchema>;

const BaseResolutionDetailsSchema = z.object({
  value: VariantValueSchema,
  variantName: z.string().nullable(),
  reason: ResolutionReasonSchema,
  ruleId: z.string().optional(),
  errorCode: ErrorCodeSchema.optional(),
  errorMessage: z.string().optional(),
});

export const ResolutionDetailsSchema = BaseResolutionDetailsSchema.refine(hasValidErrorFields, {
  message: "errorCode/errorMessage are present iff reason === 'ERROR'",
}).refine(hasValidRuleId, {
  message: "ruleId is required iff reason === 'TARGETING_MATCH'",
});
export type ResolutionDetails = z.infer<typeof ResolutionDetailsSchema>;

function hasValidErrorFields(d: z.infer<typeof BaseResolutionDetailsSchema>): boolean {
  if (d.reason === "ERROR") {
    return d.errorCode != null;
  }
  return d.errorCode == null && d.errorMessage == null;
}

function hasValidRuleId(d: z.infer<typeof BaseResolutionDetailsSchema>): boolean {
  if (d.reason === "TARGETING_MATCH") {
    return d.ruleId != null;
  }
  return d.ruleId == null;
}

export const DataPlaneEvaluateResponseSchema = z
  .object({
    variant: VariantValueSchema.nullable(),
  })
  .strict();
export type DataPlaneEvaluateResponse = z.infer<typeof DataPlaneEvaluateResponseSchema>;

export const PeekEvaluateResponseSchema = z
  .object({
    variant: VariantValueSchema,
  })
  .strict();
export type PeekEvaluateResponse = z.infer<typeof PeekEvaluateResponseSchema>;
