import { z } from "zod";
import { ErrorCodeSchema } from "../error-code";

/**
 * Batched Exposure Ticket redemption wire shapes for `POST /api/sdk/exposures`
 * (ADR-0048). Mirrors the Web Event batch envelope discipline: non-empty, max 25
 * items, max 32 KiB UTF-8 JSON body (enforced by the Worker, not only Zod).
 *
 * docs/spec/sdk/exposures-endpoint.md
 *
 * This leaf stays free of `leaf-schemas-runtime` / `wire-envelopes-core` so the
 * public SDK contract-surface pack cannot pull Organization or test-eval schemas.
 */

/** Max items per Exposure batch (Web Event parity). */
export const EXPOSURE_BATCH_MAX_ITEMS = 25;
/** Max UTF-8 JSON body bytes for an Exposure batch (Web Event parity). */
export const EXPOSURE_BATCH_MAX_BODY_BYTES = 32 * 1024;

const UuidSchema = z.string().uuid();

export const ExposureBatchItemSchema = z
  .object({
    exposureId: UuidSchema,
    exposureTicket: z.string().min(1),
    clientTimestamp: z.string().datetime({ offset: true }),
  })
  .strict();
export type ExposureBatchItem = z.infer<typeof ExposureBatchItemSchema>;

export const ExposureBatchRequestSchema = z
  .object({
    exposures: z.array(ExposureBatchItemSchema).min(1).max(EXPOSURE_BATCH_MAX_ITEMS),
  })
  .strict();
export type ExposureBatchRequest = z.infer<typeof ExposureBatchRequestSchema>;

export const ExposureBatchResultStatusSchema = z.enum(["accepted", "deduplicated", "rejected"]);
export type ExposureBatchResultStatus = z.infer<typeof ExposureBatchResultStatusSchema>;

export const ExposureBatchResultSchema = z
  .object({
    exposureId: UuidSchema,
    status: ExposureBatchResultStatusSchema,
    code: ErrorCodeSchema.nullable(),
  })
  .strict()
  .refine((row) => (row.status === "rejected" ? row.code !== null : row.code === null), {
    message: "code is present iff status === 'rejected'",
  });
export type ExposureBatchResult = z.infer<typeof ExposureBatchResultSchema>;

export const ExposureBatchResponseSchema = z
  .object({
    results: z.array(ExposureBatchResultSchema),
  })
  .strict();
export type ExposureBatchResponse = z.infer<typeof ExposureBatchResponseSchema>;
