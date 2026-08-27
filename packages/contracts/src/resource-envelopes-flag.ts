import { z } from "zod";
import { FlagSchema, VariantSchema } from "./leaf-schemas-flag";
import { SlugSchema } from "./slug";
import { listResponse } from "./wire-envelopes-core";
import {
  ApprovalRequestSchema,
  InlineApproveAndApplyReviewSchema,
} from "./routes/route-shapes-approval-request";

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
//
// `idempotency_key` is required because a Flag create is now an Idempotency-Key
// route: creating a Flag re-establishes a key that a gated delete just refused
// to free, so a retried create must never mint a second definition. Callers that
// speak JSON only (MCP tools, the CLI) carry the key here and the SDK lifts it
// into the `Idempotency-Key` header the Worker enforces.
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
    // Immutable after create (DEFINITION audit boundary). A Flag key is a
    // caller-chosen handle that appears in selectors and URLs, so it takes the
    // system's one slug shape — the same rule App keys and Org slugs follow.
    key: SlugSchema,
    schema: FlagSchema.shape.schema,
    variants: z.array(CreateVariantCatalogEntrySchema).min(1),
    description: z.string().optional(),
    idempotency_key: z.string().min(1),
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

/**
 * The intentionally small per-Environment projection used by the Flag catalog.
 * Full availability and Targeting Rule detail stays on `flag_config_get`.
 */
export const FlagConfigurationSummarySchema = z
  .object({
    enabled: z.boolean(),
    rollout: z.number().min(0).max(100).nullable(),
    defaultVariant: z.string().min(1),
    availableVariantNames: z.array(z.string().min(1)),
    targetingRuleRolloutPercentages: z.array(z.number().min(0).max(100)),
    experiment: z.object({ id: z.string().min(1), name: z.string().min(1) }).nullable(),
  })
  .strict();
export type FlagConfigurationSummary = z.infer<typeof FlagConfigurationSummarySchema>;

export const FlagListItemSchema = FlagResponseSchema.extend({
  flagConfiguration: FlagConfigurationSummarySchema.optional(),
});
export type FlagListItem = z.infer<typeof FlagListItemSchema>;

// ---------------------------------------------------------------------------
// FlagListResponse
//
// The Flag catalog read is BOUNDED, and the bound rides on the shared list
// envelope. `readTruncated` says the App holds more Flags than `readLimit`, so
// `items` is the newest page of the catalog and not the catalog. It is OBSERVED
// by the Worker (one row past the ceiling), never inferred from `items.length`.
// `cursor` is present-with-null: this catalog is not paginable, so it stays
// null and completeness is read from `readTruncated` alone.
// ---------------------------------------------------------------------------

export const FlagListResponseSchema = listResponse(FlagListItemSchema);
export type FlagListResponse = z.infer<typeof FlagListResponseSchema>;

// ---------------------------------------------------------------------------
// CreateVariantRequest (Variant sub-resource)
//
// `flag_variants_create` is an Idempotency-Key route, so `idempotency_key` is
// REQUIRED: a retried create after a timeout replays instead of adding a second
// Variant (mcp-tool-derivation "Idempotency on retried creates"). Worker
// computes the Variant `id`.
// ---------------------------------------------------------------------------

export const CreateVariantRequestSchema = z
  .object({
    appId: z.string(),
    flagId: z.string(),
    name: z.string(),
    value: VariantSchema.shape.value,
    isDefault: z.boolean().optional(),
    description: z.string().optional(),
    review: InlineApproveAndApplyReviewSchema.optional(),
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

/**
 * Variant writes return the same Flag fields `flags_get` does, with
 * `approvalRequest` alongside rather than wrapping the Flag (SPL-451).
 */
export const FlagMutationResponseSchema = FlagResponseSchema.extend({
  approvalRequest: ApprovalRequestSchema.nullable(),
}).strict();
export type FlagMutationResponse = z.infer<typeof FlagMutationResponseSchema>;
