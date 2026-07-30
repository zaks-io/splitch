import { z } from "zod";
import { ErrorCodeSchema } from "../error-code";
import { ResolutionReasonSchema } from "./resolution-reason";
import { type VariantValue, VariantValueSchema } from "./variant-value";

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

export type { VariantValue };
