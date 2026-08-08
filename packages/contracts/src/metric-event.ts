import { z } from "zod";
import { TelemetryTokenSchema } from "./event-definition";

const MetricEventValueSchema = z.union([
  z.boolean(),
  z.string(),
  z.number().finite(),
  z.null(),
  z.array(z.unknown()),
  z.record(z.string(), z.unknown()),
]);

export const MetricEventTrackRequestSchema = z
  .object({
    eventName: TelemetryTokenSchema,
    targetingKey: z.string().min(1),
    idType: z.string().min(1),
    eventId: z
      .string()
      .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
    fields: z.record(z.string(), MetricEventValueSchema),
    dimensions: z.record(z.string(), z.union([z.boolean(), z.string(), z.number().finite()])),
  })
  .strict();

export const MetricEventTrackResponseSchema = z
  .object({
    accepted: z.literal(true),
    duplicate: z.boolean(),
    eventId: MetricEventTrackRequestSchema.shape.eventId,
    eventDefinitionId: z.string(),
    eventDefinitionVersionId: z.string(),
  })
  .strict();

export type MetricEventTrackRequest = z.infer<typeof MetricEventTrackRequestSchema>;
export type MetricEventTrackResponse = z.infer<typeof MetricEventTrackResponseSchema>;
