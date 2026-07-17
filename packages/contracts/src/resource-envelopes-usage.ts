import { z } from "zod";

const EvaluationCountSchema = z.number().int().nonnegative();

const AppUsageSchema = z
  .object({
    appId: z.string(),
    evaluations: EvaluationCountSchema,
  })
  .strict();

const EnvironmentUsageSchema = z
  .object({
    environmentId: z.string(),
    evaluations: EvaluationCountSchema,
  })
  .strict();

const BatchUsageSchema = z
  .object({
    mode: z.enum(["single", "batch"]),
    evaluations: EvaluationCountSchema,
  })
  .strict();

const SourceUsageSchema = z
  .object({
    source: z.enum(["remote", "cached"]),
    evaluations: EvaluationCountSchema,
  })
  .strict();

const ExposureUsageSchema = z
  .object({
    exposure: z.enum(["bearing", "not_bearing"]),
    evaluations: EvaluationCountSchema,
  })
  .strict();

const UsagePeriodSchema = z
  .object({
    month: z.string().regex(/^\d{4}-\d{2}$/),
    startsAt: z.string(),
    endsAt: z.string(),
  })
  .strict();

export const OrganizationUsageResponseSchema = z
  .object({
    organizationId: z.string(),
    period: UsagePeriodSchema,
    state: z.enum(["zero", "populated"]),
    evaluations: EvaluationCountSchema,
    breakdown: z
      .object({
        byApp: z.array(AppUsageSchema),
        byEnvironment: z.array(EnvironmentUsageSchema),
        byBatch: z.array(BatchUsageSchema),
        bySource: z.array(SourceUsageSchema),
        byExposure: z.array(ExposureUsageSchema),
      })
      .strict(),
  })
  .strict();

export type OrganizationUsageResponse = z.infer<typeof OrganizationUsageResponseSchema>;
