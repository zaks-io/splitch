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
import { SrmRootCauseClassificationSchema } from "./srm-root-cause";
import { AnalysisResultsMissingInputSchema, StatsOutputSchema } from "./stats-result-contract";

/**
 * Public Experiment results response produced by the Control Plane.
 *
 * Additive over the Analysis envelope: existing fields keep their names and
 * types. New members lead with readiness / blockedBy / reasons. Discriminated
 * on `view` so concise keeps operational handles without dropping required
 * detailed fields from the detailed member.
 */

const readinessFields = {
  readiness: ExperimentResultsReadinessSchema,
  blockedBy: z.array(DecisionGateCheckIdSchema),
  reasons: z.array(z.string()),
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

/** Fabijan SRM root-cause; present only when Exposure or activated SRM fired. */
const srmRootCauseField = {
  srm_root_cause: SrmRootCauseClassificationSchema.optional(),
} as const;

const readyDetailedSchema = z
  .object({
    view: z.literal("detailed"),
    state: z.literal("ready"),
    ...readinessFields,
    gate: ExperimentDecisionGateSchema,
    ...runIdentityFields,
    ...evidencePair,
    run_commitments: RunCommitmentsSchema.optional(),
    ...srmRootCauseField,
    stats: StatsOutputSchema,
  })
  .strict()
  .superRefine(evidencePairRefine);

const readyConciseSchema = z
  .object({
    view: z.literal("concise"),
    state: z.literal("ready"),
    ...readinessFields,
    gate: ExperimentDecisionGateSchema,
    ...runIdentityFields,
    ...evidencePair,
    run_commitments: RunCommitmentsSchema.optional(),
    ...srmRootCauseField,
  })
  .strict()
  .superRefine(evidencePairRefine);

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

/** Request option shared by GET query and POST body. Default is detailed. */
export const ExperimentResultsViewRequestSchema = z
  .object({
    view: ExperimentResultsViewSchema.optional(),
  })
  .strict();

function evidencePairRefine(
  result: { data_watermark?: string; result_token?: string },
  context: z.RefinementCtx,
): void {
  if ((result.data_watermark === undefined) === (result.result_token === undefined)) return;
  context.addIssue({
    code: "custom",
    message: "data_watermark and result_token must be present together",
  });
}
