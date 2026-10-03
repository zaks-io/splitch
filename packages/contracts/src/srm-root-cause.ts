import { z } from "zod";

/**
 * Wire shape for the Fabijan et al. 2019 SRM root-cause classifier.
 * Classification logic lives in `@splitch/stats` (`classifySrmRootCause`);
 * this schema is what Results / diagnostics may optionally carry.
 */

export const srmRootCauseBranches = ["triggered_only", "unclassified"] as const;

export const SrmRootCauseBranchSchema = z.enum(srmRootCauseBranches);

export const SrmRootCauseClassificationSchema = z
  .object({
    branch: SrmRootCauseBranchSchema,
    explanation: z.string().min(1),
    nextCheck: z.string().min(1),
    evidenceConsidered: z.array(z.string().min(1)).optional(),
  })
  .strict();

export type SrmRootCauseBranch = z.infer<typeof SrmRootCauseBranchSchema>;
export type SrmRootCauseClassification = z.infer<typeof SrmRootCauseClassificationSchema>;
