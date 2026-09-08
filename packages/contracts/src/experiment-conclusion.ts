import { z } from "@hono/zod-openapi";
import { CanonicalJsonSha256Schema } from "./canonical-hash";
import { RunSchema } from "./leaf-schemas-experiment";
import { IdempotencyKeySchema, PersistedDescriptionSchema } from "./persisted-field-limits";
import {
  ApprovalRequestSchema,
  InlineApproveAndApplyReviewSchema,
} from "./routes/route-shapes-approval-request";
import { TargetingRuleInputSchema } from "./write-persisted-schemas";

export const ProposedWinnerFlagConfigSchema = z
  .object({
    enabled: z.boolean(),
    availableVariantNames: z.array(z.string()),
    targetingRules: z.array(TargetingRuleInputSchema),
    rollout: z
      .object({ percentage: z.number().min(0).max(100) })
      .strict()
      .nullable(),
  })
  .strict();

export const ConcludeRunRequestSchema = z
  .object({
    selectedVariant: z.string().min(1),
    expectedResultToken: CanonicalJsonSha256Schema,
    dataWatermark: z.string().datetime({ offset: true }),
    target: z
      .object({
        environmentId: z.string().min(1),
        flagId: z.string().min(1),
        expectedConfigVersion: z.number().int().min(0),
        proposedConfig: ProposedWinnerFlagConfigSchema,
      })
      .strict(),
    review: InlineApproveAndApplyReviewSchema.optional(),
    reason: PersistedDescriptionSchema.optional(),
    idempotencyKey: IdempotencyKeySchema,
  })
  .strict();
export type ConcludeRunRequest = z.infer<typeof ConcludeRunRequestSchema>;

export const ExperimentConclusionSchema = z
  .object({
    id: z.string(),
    runId: z.string(),
    selectedVariant: z.string(),
    resultToken: CanonicalJsonSha256Schema,
    dataWatermark: z.string().datetime({ offset: true }),
    concludedAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type ExperimentConclusion = z.infer<typeof ExperimentConclusionSchema>;

export const ConcludeRunResponseSchema = z
  .object({
    run: RunSchema,
    conclusion: ExperimentConclusionSchema,
    approvalRequest: ApprovalRequestSchema,
  })
  .strict();
export type ConcludeRunResponse = z.infer<typeof ConcludeRunResponseSchema>;

export const CreateConclusionPromotionRequestSchema = z
  .object({
    expectedConfigVersion: z.number().int().min(0),
    review: InlineApproveAndApplyReviewSchema.optional(),
    idempotencyKey: IdempotencyKeySchema,
  })
  .strict();
export type CreateConclusionPromotionRequest = z.infer<
  typeof CreateConclusionPromotionRequestSchema
>;

export const CreateConclusionPromotionResponseSchema = z
  .object({
    conclusion: ExperimentConclusionSchema,
    approvalRequest: ApprovalRequestSchema,
  })
  .strict();
export type CreateConclusionPromotionResponse = z.infer<
  typeof CreateConclusionPromotionResponseSchema
>;
