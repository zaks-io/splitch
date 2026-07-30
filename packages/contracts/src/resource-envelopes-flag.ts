import { z } from "zod";
import { FlagSchema, VariantSchema } from "./leaf-schemas-flag";
import { ApprovalRequestSchema, InlineApproveAndApplyReviewSchema } from "./routes/route-shapes";

/**
 * Create/patch/response wire envelopes for App-level Flag definition and
 * Variant catalog resources, composed from the flag-side leaves.
 * Source of truth: docs/spec/contracts/request-response-envelopes-flag-variant.md
 *
 * Envelopes are DISTINCT from the leaf and from each other (ADR-0025 "reuse at
 * the leaf"): create and patch carry different required fields, and the immutable
 * key/appId boundary is enforced structurally by `.strict()` on patch so a caller
 * cannot smuggle a frozen field past parse (fail loud).
 */

// ---------------------------------------------------------------------------
// CreateFlagRequest
//
// Seeds the App-level DEFINITION (key, schema, Variant catalog, Default
// Variant). Per-Environment Configuration is deliberately absent here.
// ---------------------------------------------------------------------------

const CreateVariantCatalogEntrySchema = z
  .object({
    name: z.string(),
    value: VariantSchema.shape.value,
    isDefault: z.boolean(),
    description: z.string().optional(),
  })
  .strict();

export const CreateFlagRequestSchema = z
  .object({
    appId: z.string(),
    name: z.string(),
    // Immutable after create (DEFINITION audit boundary).
    key: z.string(),
    schema: FlagSchema.shape.schema,
    variants: z.array(CreateVariantCatalogEntrySchema).min(1),
    description: z.string().optional(),
  })
  .strict();
export type CreateFlagRequest = z.infer<typeof CreateFlagRequestSchema>;

// ---------------------------------------------------------------------------
// PatchFlagRequest
//
// `.strict()` so `enabled`, immutable ids, or any unknown key are rejected at
// parse time. Variants are managed via the /variants sub-resource.
// ---------------------------------------------------------------------------

export const PatchFlagRequestSchema = z
  .object({
    name: z.string().optional(),
    schema: FlagSchema.shape.schema,
    description: z.string().optional(),
  })
  .strict();
export type PatchFlagRequest = z.infer<typeof PatchFlagRequestSchema>;

// ---------------------------------------------------------------------------
// FlagResponse
//
// The full Flag leaf. No storage internals leak (the leaf carries no version /
// createdBy). Reusing the leaf keeps the wire shape in lockstep with storage.
// ---------------------------------------------------------------------------

export const FlagResponseSchema = FlagSchema;
export type FlagResponse = z.infer<typeof FlagResponseSchema>;

// ---------------------------------------------------------------------------
// CreateVariantRequest (Variant sub-resource)
//
// `idempotency_key` is optional on this non-idempotent create so a retried
// `flag_variants_create` after a timeout never double-creates (mcp-tool-derivation
// "Idempotency on retried creates"). Worker computes the Variant `id`.
// ---------------------------------------------------------------------------

export const CreateVariantRequestSchema = z
  .object({
    appId: z.string(),
    flagId: z.string(),
    name: z.string(),
    value: VariantSchema.shape.value,
    isDefault: z.boolean().optional(),
    description: z.string().optional(),
    idempotency_key: z.string().min(1),
  })
  .strict();
export type CreateVariantRequest = z.infer<typeof CreateVariantRequestSchema>;

// ---------------------------------------------------------------------------
// PatchVariantRequest
//
// `value` is Run-frozen: the Worker rejects a value change with `RUN_FROZEN`
// when a running Run's `variantSet` includes this Variant (that runtime check
// needs the live Run, so it lives in the Worker; the field is patchable here).
// `.strict()` rejects unknown keys loudly.
// ---------------------------------------------------------------------------

export const PatchVariantRequestSchema = z
  .object({
    name: z.string().optional(),
    value: VariantSchema.shape.value.optional(),
    description: z.string().optional(),
    review: InlineApproveAndApplyReviewSchema.optional(),
    idempotency_key: z.string().min(1),
  })
  .strict();
export type PatchVariantRequest = z.infer<typeof PatchVariantRequestSchema>;

export const FlagMutationResponseSchema = z
  .object({
    flag: FlagResponseSchema,
    approvalRequest: ApprovalRequestSchema.nullable(),
  })
  .strict();
export type FlagMutationResponse = z.infer<typeof FlagMutationResponseSchema>;
