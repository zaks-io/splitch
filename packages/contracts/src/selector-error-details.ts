import { z } from "zod";

const AppSelectorCandidateSchema = z
  .object({
    orgSlug: z.string().min(1),
    appId: z.string().min(1),
    appSlug: z.string().min(1),
  })
  .strict();

const EnvironmentSelectorCandidateSchema = z
  .object({
    environmentId: z.string().min(1),
    environmentKey: z.string().min(1),
  })
  .strict();

export const SelectorAmbiguousDetailsSchema = z
  .object({
    recommendedAction: z.literal("USE_CANONICAL_ID"),
    candidates: z
      .array(z.union([AppSelectorCandidateSchema, EnvironmentSelectorCandidateSchema]))
      .min(2),
  })
  .strict();
