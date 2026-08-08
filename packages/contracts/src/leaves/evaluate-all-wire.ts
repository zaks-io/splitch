import { z } from "zod";
import { ErrorCodeSchema } from "../error-code";
import { OWN_PROTO_KEY, protoSafeRecord } from "../proto-safe-record";
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

const PROTO_KEY_MESSAGE = `must not contain a "${OWN_PROTO_KEY}" key`;

/** Proto-safe attributes map (`record` + refine so OpenAPI/CLI help keep the record shape). */
export const EvaluateAllAttributesSchema = protoSafeRecord(AttributeValueSchema, PROTO_KEY_MESSAGE);

export const EvaluateAllRequestSchema = z.object({
  appId: NonEmptyDataPlaneStringSchema.optional(),
  targetingKey: NonEmptyDataPlaneStringSchema,
  idType: NonEmptyDataPlaneStringSchema,
  attributes: EvaluateAllAttributesSchema.default({}),
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

/**
 * Proto-safe evaluations map. Zod's `z.record` would otherwise silently drop a
 * JSON own `"__proto__"` Flag Key. Both this contract and the SDK's compiled,
 * zod-free response parser refuse that key. Built as `record` + refine so the
 * served OpenAPI document keeps the real additionalProperties shape (not `{}`).
 */
export const EvaluateAllEvaluationsSchema = protoSafeRecord(
  EvaluateAllEntrySchema,
  PROTO_KEY_MESSAGE,
);

export const EvaluateAllResponseSchema = z
  .object({
    evaluations: EvaluateAllEvaluationsSchema,
  })
  .strict();
export type EvaluateAllResponse = z.infer<typeof EvaluateAllResponseSchema>;
