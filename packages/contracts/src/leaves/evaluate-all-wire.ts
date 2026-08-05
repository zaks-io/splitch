import { z } from "zod";
import { ErrorCodeSchema } from "../error-code";
import { VariantValueSchema } from "./variant-value";

/**
 * Precomputed Evaluations wire shapes for `POST /api/sdk/evaluate-all` (ADR-0048).
 *
 * Destination-fixed disclosure: every credential tier gets the same non-revealing
 * reason set. Optional fields are present-with-null, never omitted
 * (docs/spec/sdk/evaluate-all-endpoint.md).
 *
 * This leaf stays free of `leaf-schemas-runtime` / `wire-envelopes-core` so the
 * public SDK contract-surface pack cannot pull Organization or test-eval schemas.
 */

const NonEmptyDataPlaneStringSchema = z.string().min(1);
const AttributeValueSchema = z.union([z.boolean(), z.string(), z.number(), z.array(z.unknown())]);

export const EvaluateAllRequestSchema = z.object({
  appId: NonEmptyDataPlaneStringSchema.optional(),
  targetingKey: NonEmptyDataPlaneStringSchema,
  idType: NonEmptyDataPlaneStringSchema,
  attributes: z.record(z.string(), AttributeValueSchema).default({}),
});
export type EvaluateAllRequest = z.infer<typeof EvaluateAllRequestSchema>;

export const EvaluateAllReasonSchema = z.enum(["SPLIT", "DEFAULT", "DISABLED", "ERROR"]);
export type EvaluateAllReason = z.infer<typeof EvaluateAllReasonSchema>;

const EvaluateAllEntryBaseSchema = z
  .object({
    variant: VariantValueSchema.nullable(),
    variantName: z.string().nullable(),
    reason: EvaluateAllReasonSchema,
    errorCode: ErrorCodeSchema.nullable(),
    exposureTicket: z.string().nullable(),
  })
  .strict();

export const EvaluateAllEntrySchema = EvaluateAllEntryBaseSchema.refine(
  (entry) => (entry.reason === "ERROR" ? entry.errorCode !== null : entry.errorCode === null),
  { message: "errorCode is present iff reason === 'ERROR'" },
).refine((entry) => entry.reason === "SPLIT" || entry.exposureTicket === null, {
  message: "exposureTicket is only allowed when reason === 'SPLIT'",
});
export type EvaluateAllEntry = z.infer<typeof EvaluateAllEntrySchema>;

export const EvaluateAllResponseSchema = z
  .object({
    evaluations: z.record(z.string(), EvaluateAllEntrySchema),
  })
  .strict();
export type EvaluateAllResponse = z.infer<typeof EvaluateAllResponseSchema>;
