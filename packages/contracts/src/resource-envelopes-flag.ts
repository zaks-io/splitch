import { z } from "zod";
import { FlagSchema, VariantSchema } from "./leaf-schemas-flag.js";

/**
 * Create/patch/response wire envelopes for the Flag and Variant control-plane
 * resources, composed from the flag-side leaves (never redefining them).
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
// Seeds the App-level DEFINITION (key, name, variant catalog) plus the initial
// per-Environment CONFIGURATION for `environmentId` (ADR-0027). Worker computes
// id/createdAt/updatedAt, so they are absent here.
// ---------------------------------------------------------------------------

export const CreateFlagRequestSchema = z.object({
  appId: z.string(),
  environmentId: z.string(),
  name: z.string(),
  // Immutable after create (DEFINITION audit boundary).
  key: z.string(),
  variants: z.array(VariantSchema).min(1),
  enabled: z.boolean(),
  // Per-Environment subset of the catalog; defaults to all when omitted.
  availableVariantNames: z.array(z.string()).optional(),
  defaultVariantId: z.string(),
  targetingRules: FlagSchema.shape.targetingRules.default([]),
  description: z.string().optional(),
});
export type CreateFlagRequest = z.infer<typeof CreateFlagRequestSchema>;

// ---------------------------------------------------------------------------
// PatchFlagRequest
//
// `.strict()` so an immutable `key` or `appId` (or any unknown key) is REJECTED
// at parse time, not silently dropped — the audit boundary is enforced by the
// schema, not left to the Worker. Variants/TargetingRules are managed via the
// /variants and /targeting-rules sub-resources, so they are not patchable here.
// ---------------------------------------------------------------------------

export const PatchFlagRequestSchema = z
  .object({
    name: z.string().optional(),
    enabled: z.boolean().optional(),
    availableVariantNames: z.array(z.string()).optional(),
    defaultVariantId: z.string().optional(),
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

export const CreateVariantRequestSchema = z.object({
  flagId: z.string(),
  name: z.string(),
  value: VariantSchema.shape.value,
  description: z.string().optional(),
  idempotency_key: z.string().optional(),
});
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
  })
  .strict();
export type PatchVariantRequest = z.infer<typeof PatchVariantRequestSchema>;
