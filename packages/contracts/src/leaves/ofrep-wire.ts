import { z } from "zod";
import { VariantValueSchema } from "./variant-value";

/**
 * OFREP Core request/response leaves (OpenFeature Remote Evaluation Protocol).
 * Shapes follow github.com/open-feature/protocol service/openapi.yaml Core paths.
 * Auth and billing stay on the existing data-plane credential and ADR-0033 rules.
 */

const OfrepKeySchema = z.string().min(1);

export const OfrepContextSchema = z
  .object({
    targetingKey: z.unknown().optional(),
  })
  .catchall(z.unknown());

export const OfrepEvaluationRequestSchema = z
  .object({
    context: OfrepContextSchema,
  })
  .strict();
export type OfrepEvaluationRequest = z.infer<typeof OfrepEvaluationRequestSchema>;

export const OfrepBulkEvaluationRequestSchema = z
  .object({
    context: OfrepContextSchema,
  })
  .strict();
export type OfrepBulkEvaluationRequest = z.infer<typeof OfrepBulkEvaluationRequestSchema>;

export const OfrepReasonSchema = z.enum([
  "STATIC",
  "TARGETING_MATCH",
  "SPLIT",
  "DISABLED",
  "UNKNOWN",
]);
export type OfrepReason = z.infer<typeof OfrepReasonSchema>;

export const OfrepErrorCodeSchema = z.enum([
  "PARSE_ERROR",
  "TARGETING_KEY_MISSING",
  "INVALID_CONTEXT",
  "FLAG_NOT_FOUND",
  "GENERAL",
]);
export type OfrepErrorCode = z.infer<typeof OfrepErrorCodeSchema>;

export const OfrepMetadataSchema = z.record(
  z.string(),
  z.union([z.boolean(), z.string(), z.number()]),
);
export type OfrepMetadata = z.infer<typeof OfrepMetadataSchema>;

export const OfrepEvaluationSuccessSchema = z
  .object({
    key: OfrepKeySchema,
    reason: OfrepReasonSchema,
    value: VariantValueSchema.optional(),
    variant: z.string().optional(),
    metadata: OfrepMetadataSchema.optional(),
  })
  .strict();
export type OfrepEvaluationSuccess = z.infer<typeof OfrepEvaluationSuccessSchema>;

export const OfrepEvaluationFailureSchema = z
  .object({
    key: OfrepKeySchema,
    errorCode: OfrepErrorCodeSchema,
    errorDetails: z.string().optional(),
    metadata: OfrepMetadataSchema.optional(),
  })
  .strict();
export type OfrepEvaluationFailure = z.infer<typeof OfrepEvaluationFailureSchema>;

export const OfrepBulkEvaluationSuccessSchema = z
  .object({
    flags: z.array(z.union([OfrepEvaluationSuccessSchema, OfrepEvaluationFailureSchema])),
    metadata: OfrepMetadataSchema.optional(),
  })
  .strict();
export type OfrepBulkEvaluationSuccess = z.infer<typeof OfrepBulkEvaluationSuccessSchema>;

export const OfrepBulkEvaluationFailureSchema = z
  .object({
    errorCode: OfrepErrorCodeSchema,
    errorDetails: z.string().optional(),
  })
  .strict();
export type OfrepBulkEvaluationFailure = z.infer<typeof OfrepBulkEvaluationFailureSchema>;

export const OfrepGeneralErrorSchema = z
  .object({
    errorDetails: z.string(),
  })
  .strict();
export type OfrepGeneralError = z.infer<typeof OfrepGeneralErrorSchema>;

export const OfrepFlagKeyParamsSchema = z
  .object({
    key: OfrepKeySchema,
  })
  .strict();
