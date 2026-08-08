import { z } from "zod";

export const SegmentDependenciesSchema = z.object({
  flagConfigurations: z.array(
    z.object({
      flagConfigurationId: z.string(),
      flagId: z.string(),
      flagKey: z.string(),
      flagName: z.string(),
      environmentId: z.string(),
      environmentKey: z.string(),
      environmentName: z.string(),
      targetingRuleIds: z.array(z.string()),
    }),
  ),
  experimentDrafts: z.array(
    z.object({
      experimentId: z.string(),
      experimentName: z.string(),
      environmentId: z.string(),
      environmentKey: z.string(),
      environmentName: z.string(),
    }),
  ),
});

export const SegmentNotFoundDetailsSchema = z
  .object({ missingSegmentIds: z.array(z.string()).optional() })
  .strict();
