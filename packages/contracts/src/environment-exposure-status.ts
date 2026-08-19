import { z } from "zod";

const NotReceivedExposureStatusSchema = z
  .object({
    state: z.literal("not_received"),
    firstExposureAt: z.null(),
  })
  .strict();

const ReceivedExposureStatusSchema = z
  .object({
    state: z.literal("received"),
    firstExposureAt: z.string().datetime({ offset: true }),
  })
  .strict();

export const EnvironmentExposureStatusResponseSchema = z.discriminatedUnion("state", [
  NotReceivedExposureStatusSchema,
  ReceivedExposureStatusSchema,
]);

export type EnvironmentExposureStatusResponse = z.infer<
  typeof EnvironmentExposureStatusResponseSchema
>;
