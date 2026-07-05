import { z } from "zod";
import { VariantValueSchema } from "./variant-value";

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
