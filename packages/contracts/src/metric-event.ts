import { z } from "zod";
import { TelemetryTokenSchema } from "./event-definition";
import { OWN_PROTO_KEY, protoSafeRecord } from "./proto-safe-record";

const PROTO_KEY_MESSAGE = `must not contain a "${OWN_PROTO_KEY}" key`;

const MetricEventValueSchema = z.union([
  z.boolean(),
  z.string(),
  z.number().finite(),
  z.null(),
  z.array(z.unknown()),
  protoSafeRecord(z.unknown(), PROTO_KEY_MESSAGE),
]);

export const MetricEventTrackRequestSchema = z
  .object({
    eventName: TelemetryTokenSchema,
    targetingKey: z.string().min(1),
    idType: z.string().min(1),
    eventId: z
      .string()
      .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
    fields: protoSafeRecord(MetricEventValueSchema, PROTO_KEY_MESSAGE),
    dimensions: protoSafeRecord(
      z.union([z.boolean(), z.string(), z.number().finite()]),
      PROTO_KEY_MESSAGE,
    ),
  })
  .strict();

export const MetricEventTrackResponseSchema = z
  .object({
    accepted: z.literal(true),
    duplicate: z.boolean(),
    eventId: MetricEventTrackRequestSchema.shape.eventId,
    eventDefinitionId: z.string().optional(),
    eventDefinitionVersionId: z.string().optional(),
  })
  .strict();

export type MetricEventTrackRequest = z.infer<typeof MetricEventTrackRequestSchema>;
export type MetricEventTrackResponse = z.infer<typeof MetricEventTrackResponseSchema>;
