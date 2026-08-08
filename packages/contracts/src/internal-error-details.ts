import { z } from "zod";

/**
 * One dependent Flag Configuration affected by Segment republication. The
 * identity stays at Flag Configuration granularity because sibling Flags in the
 * same Environment settle independently.
 */
const RepublishedFlagConfigurationSchema = z
  .object({
    flagConfigurationId: z.string(),
    flagId: z.string(),
    flagKey: z.string(),
    flagName: z.string(),
    environmentId: z.string(),
    environmentKey: z.string(),
    environmentName: z.string(),
  })
  .strict();

const NotRepublishedFlagConfigurationSchema = RepublishedFlagConfigurationSchema.extend({
  reason: z.string(),
  fault: z.string().optional(),
  frozenFields: z.array(z.string()).optional(),
  currentRunId: z.string().optional(),
  attemptedChange: z.string().optional(),
  missingVariants: z.array(z.string()).optional(),
  missingSegmentIds: z.array(z.string()).optional(),
  availableVariantNames: z.array(z.string()).optional(),
}).strict();

export const SegmentRepublishDetailsShape = {
  republishedFlagConfigurations: z.array(RepublishedFlagConfigurationSchema).optional(),
  notRepublishedFlagConfigurations: z.array(NotRepublishedFlagConfigurationSchema).optional(),
};

/** `INTERNAL_SERVER_ERROR` details, including every settled fan-out result. */
export const InternalServerErrorDetailsSchema = z
  .object({
    fault: z.string().optional(),
    ...SegmentRepublishDetailsShape,
  })
  .strict();
