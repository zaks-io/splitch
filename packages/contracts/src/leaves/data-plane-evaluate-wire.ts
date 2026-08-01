import { z } from "zod";
import { VariantValueSchema } from "./variant-value";

/**
 * This body is frozen. Published SDKs parse it with their own inlined copy of
 * this schema, and that copy is `.strict()`, so an added key makes the client
 * throw, swallow the throw, and serve the caller's default -- after the Worker
 * already committed the Exposure. That is silent Experiment corruption, not a
 * degraded response.
 *
 * New evaluation metadata therefore rides a response header (see `x-run-id` and
 * `x-variant-name` in apps/evaluation-api), which old clients ignore. A field
 * may only move into the body once no supported SDK parses it strictly.
 */
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
