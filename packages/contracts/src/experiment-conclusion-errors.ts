import { z } from "zod";
import { CanonicalJsonSha256Schema } from "./canonical-hash";
import { UnresolvableControlReasonSchema } from "./experiment-control-identity";
import type { DecisionGateCheckId } from "./experiment-decision-gate";
import { StatsResultStatusSchema } from "./stats-result-contract";

const ResultMemberSchema = z
  .object({ metricId: z.string(), variant: z.string(), status: StatsResultStatusSchema })
  .strict();

export const DecisionFailureSchema = z.discriminatedUnion("code", [
  z
    .object({
      code: z.literal("DECISION_CONTROL_IDENTITY_INVALID"),
      checkIds: z.tuple([z.literal("control_identity")]),
      details: z
        .object({
          controlVariantId: z.string(),
          frozenVariantNames: z.array(z.string()),
          reason: UnresolvableControlReasonSchema,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      code: z.literal("DECISION_RESULT_INVALID"),
      checkIds: z.union([
        z.tuple([z.literal("engine_status")]),
        z.tuple([z.literal("decision_valid_result")]),
        z.tuple([z.literal("engine_status"), z.literal("decision_valid_result")]),
      ]),
      details: z.object({ members: z.array(ResultMemberSchema) }).strict(),
    })
    .strict(),
  z
    .object({
      code: z.literal("DECISION_UNDERPOWERED"),
      checkIds: z.tuple([z.literal("underpowered")]),
      details: z.object({ members: z.array(ResultMemberSchema), lowN: z.boolean() }).strict(),
    })
    .strict(),
  z
    .object({
      code: z.literal("DECISION_SRM_MISMATCH"),
      checkIds: z.union([
        z.tuple([z.literal("exposure_srm")]),
        z.tuple([z.literal("activated_srm")]),
        z.tuple([z.literal("exposure_srm"), z.literal("activated_srm")]),
      ]),
      details: z
        .object({
          pValues: z
            .object({
              exposure_srm: z.number().nullable().optional(),
              activated_srm: z.number().nullable().optional(),
            })
            .strict(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      code: z.literal("DECISION_ACTIVATION_IMBALANCE"),
      checkIds: z.tuple([z.literal("activation_balance")]),
      details: z
        .object({ pValue: z.number().nullable(), rates: z.record(z.string(), z.number()) })
        .strict(),
    })
    .strict(),
]);
export type DecisionFailure = z.infer<typeof DecisionFailureSchema>;

export const decisionFailureCodeByCheckId = {
  control_identity: "DECISION_CONTROL_IDENTITY_INVALID",
  exposure_srm: "DECISION_SRM_MISMATCH",
  activated_srm: "DECISION_SRM_MISMATCH",
  activation_balance: "DECISION_ACTIVATION_IMBALANCE",
  engine_status: "DECISION_RESULT_INVALID",
  underpowered: "DECISION_UNDERPOWERED",
  decision_valid_result: "DECISION_RESULT_INVALID",
} as const satisfies Record<DecisionGateCheckId, DecisionFailure["code"]>;

export const DecisionBlockedDetailsSchema = z
  .object({
    runId: z.string(),
    resultToken: CanonicalJsonSha256Schema,
    dataWatermark: z.string().datetime({ offset: true }),
    failures: z.array(DecisionFailureSchema).min(1),
  })
  .strict();

export const DecisionResultStaleDetailsSchema = z
  .object({
    runId: z.string(),
    expectedResultToken: CanonicalJsonSha256Schema,
    currentResultToken: CanonicalJsonSha256Schema,
  })
  .strict();

export const DecisionResultUnavailableDetailsSchema = z
  .object({
    runId: z.string(),
    envelopeState: z.enum(["no_data", "no_run"]),
  })
  .strict();

export const TargetConfigurationStaleDetailsSchema = z
  .object({
    flagId: z.string(),
    environmentId: z.string(),
    expectedConfigVersion: z.number().int(),
    currentConfigVersion: z.number().int(),
    recommendedAction: z.literal("REFRESH_AND_REPROPOSE"),
  })
  .strict();
