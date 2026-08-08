import { z } from "zod";

/**
 * `INTERNAL_SERVER_ERROR` details. The republish arrays exist because a Segment
 * Conditions change fans out across every dependent Environment: when only some
 * of them resync, the caller needs to know exactly which Flag Configurations are
 * now stale rather than being told the whole operation failed.
 */
export const InternalServerErrorDetailsSchema = z
  .object({
    fault: z.string().optional(),
    republishedEnvironmentIds: z.array(z.string()).optional(),
    notRepublishedEnvironmentIds: z.array(z.string()).optional(),
  })
  .strict();
