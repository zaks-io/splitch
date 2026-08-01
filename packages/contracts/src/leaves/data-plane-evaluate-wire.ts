import { z } from "zod";
import { VariantValueSchema } from "./variant-value";

export const DataPlaneEvaluateResponseSchema = z
  .object({
    variant: VariantValueSchema.nullable(),
    /**
     * The resolved Variant's name — the immutable arm label, public-safe on
     * every credential tier (verify already returns it under a Client Key).
     * Null on a no-match, where there is no arm to name.
     *
     * It rides the wire because the SDK cannot synthesize it: the name is not
     * derivable from the value (two arms may share a value), so without it
     * `evaluateDetails` reported `variantName: null` forever while its own spec
     * documented a string. `reason` stays synthesized and off the wire — that
     * is the field the non-revealing tier protects, not the arm label.
     */
    variantName: z.string().nullable(),
  })
  .strict();
export type DataPlaneEvaluateResponse = z.infer<typeof DataPlaneEvaluateResponseSchema>;

export const PeekEvaluateResponseSchema = z
  .object({
    variant: VariantValueSchema,
  })
  .strict();
export type PeekEvaluateResponse = z.infer<typeof PeekEvaluateResponseSchema>;
