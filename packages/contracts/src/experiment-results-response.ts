import { z } from "zod";
import { CanonicalJsonSha256Schema } from "./canonical-hash";
import { FrozenControlIdentitySchema } from "./experiment-control-identity";
import {
  DecisionGateCheckIdSchema,
  ExperimentDecisionGateSchema,
} from "./experiment-decision-gate";
import {
  ExperimentResultsReadinessSchema,
  ExperimentResultsViewSchema,
} from "./experiment-results-readiness";
import { RunCommitmentsSchema } from "./run-commitments";
import {
  RecommendationUnavailableReasonSchema,
  ShipRecommendationSchema,
} from "./ship-recommendation";
import { SrmRootCauseClassificationSchema } from "./srm-root-cause";
import { AnalysisResultsMissingInputSchema, StatsOutputSchema } from "./stats-result-contract";

/**
 * Public Experiment results response produced by the Control Plane.
 *
 * Additive over the Analysis envelope: existing fields keep their names and
 * types. New members lead with readiness / blockedBy / reasons, then the ship
 * recommendation when a pre-registration exists (plan 2.4).
 */

const readinessFields = {
  readiness: ExperimentResultsReadinessSchema,
  blockedBy: z.array(DecisionGateCheckIdSchema),
  reasons: z.array(z.string()),
} as const;

const recommendationFields = {
  recommendation: ShipRecommendationSchema.optional(),
  recommendationUnavailable: RecommendationUnavailableReasonSchema.optional(),
} as const;

const runIdentityFields = {
  run_id: z.string().min(1),
  run_number: z.number().int().min(1),
  run_status: z.enum(["running", "ended"]),
  control_variant: z.string().min(1),
  control: FrozenControlIdentitySchema,
} as const;

const evidencePair = {
  data_watermark: z.string().datetime({ offset: true }).optional(),
  result_token: CanonicalJsonSha256Schema.optional(),
} as const;

const srmRootCauseField = {
  srm_root_cause: SrmRootCauseClassificationSchema.optional(),
} as const;

const readyDetailedSchema = z
  .object({
    view: z.literal("detailed"),
    state: z.literal("ready"),
    ...readinessFields,
    ...recommendationFields,
    gate: ExperimentDecisionGateSchema,
    ...runIdentityFields,
    ...evidencePair,
    run_commitments: RunCommitmentsSchema.optional(),
    ...srmRootCauseField,
    stats: StatsOutputSchema,
  })
  .strict()
  .superRefine(readyRefine);

const readyConciseSchema = z
  .object({
    view: z.literal("concise"),
    state: z.literal("ready"),
    ...readinessFields,
    ...recommendationFields,
    gate: ExperimentDecisionGateSchema,
    ...runIdentityFields,
    ...evidencePair,
    run_commitments: RunCommitmentsSchema.optional(),
    ...srmRootCauseField,
    /** Present only when the caller set includeExploratory on concise (C10 part two). */
    stats: StatsOutputSchema.optional(),
  })
  .strict()
  .superRefine(readyRefine);

const noDataSchema = z
  .object({
    view: ExperimentResultsViewSchema,
    state: z.literal("no_data"),
    ...readinessFields,
    ...runIdentityFields,
    missing: AnalysisResultsMissingInputSchema,
  })
  .strict();

const noRunSchema = z
  .object({
    view: ExperimentResultsViewSchema,
    state: z.literal("no_run"),
    ...readinessFields,
    recommended_action: z.literal("START_A_RUN"),
  })
  .strict();

export const ExperimentResultsResponseSchema = z.union([
  readyDetailedSchema,
  readyConciseSchema,
  noDataSchema,
  noRunSchema,
]);
export type ExperimentResultsResponse = z.infer<typeof ExperimentResultsResponseSchema>;

export const ExperimentResultsReadyDetailedSchema = readyDetailedSchema;
export const ExperimentResultsReadyConciseSchema = readyConciseSchema;

export const ExperimentResultsViewRequestSchema = z
  .object({
    view: ExperimentResultsViewSchema.optional(),
  })
  .strict();

function readyRefine(
  result: {
    data_watermark?: string;
    result_token?: string;
    recommendation?: unknown;
    recommendationUnavailable?: unknown;
  },
  context: z.RefinementCtx,
): void {
  if ((result.data_watermark === undefined) !== (result.result_token === undefined)) {
    context.addIssue({
      code: "custom",
      message: "data_watermark and result_token must be present together",
    });
  }
  if (result.recommendation !== undefined && result.recommendationUnavailable !== undefined) {
    context.addIssue({
      code: "custom",
      message: "recommendation and recommendationUnavailable are mutually exclusive",
    });
  }
  if (result.recommendation === undefined && result.recommendationUnavailable === undefined) {
    context.addIssue({
      code: "custom",
      message: "ready results require recommendation or recommendationUnavailable",
    });
  }
}
