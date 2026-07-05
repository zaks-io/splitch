import { z } from "zod";

/** VariantValue = boolean | string | number | JsonObject */
export const VariantValueSchema = z.union([
  z.boolean(),
  z.string(),
  z.number(),
  z.record(z.string(), z.unknown()),
]);
export type VariantValue = z.infer<typeof VariantValueSchema>;
