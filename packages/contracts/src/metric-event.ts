import { z } from "zod";
import { TelemetryTokenSchema } from "./event-definition";
import {
  OWN_PROTO_KEY_MESSAGE,
  protoSafeRecord,
  refuseOwnProtoTreeInParse,
} from "./proto-safe-record";

const MetricEventValueSchema = z.union([
  z.boolean(),
  z.string(),
  z.number().finite(),
  z.null(),
  z.array(z.unknown()),
  protoSafeRecord(z.unknown(), OWN_PROTO_KEY_MESSAGE),
]);

export const MetricEventTrackRequestSchema = z
  .object({
    eventName: TelemetryTokenSchema,
    targetingKey: z.string().min(1),
    idType: z.string().min(1),
    eventId: z
      .string()
      .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
    fields: protoSafeRecord(MetricEventValueSchema, OWN_PROTO_KEY_MESSAGE),
    dimensions: protoSafeRecord(
      z.union([z.boolean(), z.string(), z.number().finite()]),
      OWN_PROTO_KEY_MESSAGE,
    ),
  })
  .strict();
refuseOwnProtoTreeInParse(MetricEventTrackRequestSchema, OWN_PROTO_KEY_MESSAGE);

export const MetricEventTrackResponseSchema = z
  .object({
    accepted: z.literal(true),
    duplicate: z.boolean(),
    eventId: MetricEventTrackRequestSchema.shape.eventId,
    eventDefinitionId: z.string().optional(),
    eventDefinitionVersionId: z.string().optional(),
  })
  .strict();

export const MetricEventActivateResponseSchema = MetricEventTrackResponseSchema.extend({
  activatedRuns: z.number().int().positive(),
}).strict();

export type MetricEventTrackRequest = z.infer<typeof MetricEventTrackRequestSchema>;
export type MetricEventTrackResponse = z.infer<typeof MetricEventTrackResponseSchema>;
export type MetricEventActivateResponse = z.infer<typeof MetricEventActivateResponseSchema>;
