import { z } from "zod";

/**
 * Who the Control arm of a Run is, resolved from what the Run froze at Start.
 *
 * The Run owns both halves of the answer: the immutable `runs.control_variant_id`
 * and the `variant_set` snapshot it was validated against (ADR-0002, ADR-0003).
 * Reading the Experiment's current `default_variant_id` instead would relabel a
 * historical Run's arms the moment somebody edits the Experiment, which is the
 * whole reason the column exists (SPL-184).
 *
 * `unresolvable` exists because the SPL-184 backfill copied the Experiment's
 * then-current default onto every pre-existing Run without checking that it is a
 * member of that Run's frozen Variant set. Such a Run cannot be given a Control
 * by inference: picking the first arm, or the one named "control", would invent
 * provenance. It is named and refused instead.
 */

export const unresolvableControlReasons = [
  "absent_from_frozen_variant_set",
  "unreadable_frozen_variant_set",
] as const;
export const UnresolvableControlReasonSchema = z.enum(unresolvableControlReasons);

export const FrozenControlIdentitySchema = z.discriminatedUnion("state", [
  z
    .object({
      state: z.literal("frozen"),
      variantId: z.string().min(1),
      /** The Variant name every lift in `stats` is measured against. */
      variant: z.string().min(1),
    })
    .strict(),
  z
    .object({
      state: z.literal("disagreement"),
      variantId: z.string().min(1),
      /** The frozen Run Control identity shown in the integrity warning. */
      variant: z.string().min(1),
      /** The Run Snapshot Control that anchors lift in `stats`. */
      analysisVariant: z.string().min(1),
    })
    .strict(),
  z
    .object({
      state: z.literal("unresolvable"),
      variantId: z.string().min(1),
      reason: UnresolvableControlReasonSchema,
      /** The names the Run did freeze, so the reader can see what it is missing. */
      frozenVariantNames: z.array(z.string()),
    })
    .strict(),
]);

export type UnresolvableControlReason = z.infer<typeof UnresolvableControlReasonSchema>;
export type FrozenControlIdentity = z.infer<typeof FrozenControlIdentitySchema>;

const FrozenVariantSetSchema = z.array(
  z.object({ id: z.string().min(1), name: z.string().min(1) }).loose(),
);

export function resolveFrozenControlIdentity(
  controlVariantId: string,
  frozenVariantSetJson: string,
): FrozenControlIdentity {
  const variantSet = readFrozenVariantSet(frozenVariantSetJson);
  if (!variantSet) {
    return {
      state: "unresolvable",
      variantId: controlVariantId,
      reason: "unreadable_frozen_variant_set",
      frozenVariantNames: [],
    };
  }
  const control = variantSet.find((variant) => variant.id === controlVariantId);
  if (!control) {
    return {
      state: "unresolvable",
      variantId: controlVariantId,
      reason: "absent_from_frozen_variant_set",
      frozenVariantNames: variantSet.map((variant) => variant.name),
    };
  }
  return { state: "frozen", variantId: controlVariantId, variant: control.name };
}

export function resolveAnalysisControlIntegrity(
  control: FrozenControlIdentity,
  analysisVariant: string,
): FrozenControlIdentity {
  if (control.state !== "frozen" || control.variant === analysisVariant) return control;
  return {
    state: "disagreement",
    variantId: control.variantId,
    variant: control.variant,
    analysisVariant,
  };
}

function readFrozenVariantSet(json: string): { id: string; name: string }[] | null {
  try {
    const parsed = FrozenVariantSetSchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
