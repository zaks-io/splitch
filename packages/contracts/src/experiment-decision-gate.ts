import { z } from "zod";
import { SrmRootCauseClassificationSchema } from "./srm-root-cause";

export const srmTiers = ["clean", "possible_imbalance", "confirmed"] as const;
export const SrmTierSchema = z.enum(srmTiers);

export const decisionGateCheckIds = [
  "control_identity",
  "exposure_srm",
  "activated_srm",
  "activation_balance",
  "engine_status",
  "underpowered",
  "planned_duration",
  "decision_valid_result",
] as const;
export const DecisionGateCheckIdSchema = z.enum(decisionGateCheckIds);

export const SrmDeviationSchema = z
  .object({
    variant: z.string(),
    observed: z.number(),
    expected: z.number(),
    /**
     * Observed minus expected, computed here so every surface reports the same
     * number. A skin that subtracted the two itself would be doing arithmetic
     * on a diagnostic, which is exactly what the Worker is authoritative for.
     */
    delta: z.number(),
  })
  .strict();

export const SrmSignalSchema = z
  .object({
    tier: SrmTierSchema,
    pValue: z.number().nullable(),
    /** Per-Variant observed minus expected exposures: the cause-hunting diagnostic. */
    deviations: z.array(SrmDeviationSchema),
    /**
     * When a durable analysis-v2 SRM alarm was persisted on an earlier read,
     * the first crossing timestamp. Omitted when no alarm exists.
     */
    firstCrossedAt: z.string().datetime({ offset: true }).optional(),
  })
  .strict();

/** Persisted analysis-v2 SRM alarm rows ORed into the Control Plane verdict. */
export const PersistedSrmAlarmSchema = z
  .object({
    srmKind: z.enum(["exposure", "activated"]),
    firstCrossedAt: z.string().datetime({ offset: true }),
    pValue: z.number(),
  })
  .strict();
export type PersistedSrmAlarm = z.infer<typeof PersistedSrmAlarmSchema>;

export const ExperimentSrmDiagnosticsSchema = z
  .object({
    exposure: SrmSignalSchema,
    /** Null when the Experiment has no activation gate (ADR-0012). */
    activated: SrmSignalSchema.nullable(),
    activationBalance: z
      .object({ tier: SrmTierSchema, pValue: z.number().nullable() })
      .strict()
      .nullable(),
    /**
     * Fabijan root-cause branch. Present only when Exposure or activated SRM
     * has fired. Omitted (not null) when clean so existing clients keep the
     * pre-classifier diagnostics shape.
     */
    rootCause: SrmRootCauseClassificationSchema.optional(),
  })
  .strict();

export const DecisionGateCheckSchema = z
  .object({
    id: DecisionGateCheckIdSchema,
    /** `not_applicable` keeps a check visible without implying it passed on evidence. */
    status: z.enum(["pass", "fail", "not_applicable"]),
    title: z.string(),
    detail: z.string(),
  })
  .strict();

export const ExperimentDecisionGateSchema = z
  .object({
    shipAllowed: z.boolean(),
    blockedBy: z.array(DecisionGateCheckIdSchema),
    checks: z.array(DecisionGateCheckSchema),
    /** Names the enforcement point so a rendering surface can attribute the refusal. */
    enforcedBy: z.literal("control-plane-api"),
  })
  .strict();

export type SrmTier = z.infer<typeof SrmTierSchema>;
export type SrmDeviation = z.infer<typeof SrmDeviationSchema>;
export type SrmSignal = z.infer<typeof SrmSignalSchema>;
export type ExperimentSrmDiagnostics = z.infer<typeof ExperimentSrmDiagnosticsSchema>;
export type DecisionGateCheckId = z.infer<typeof DecisionGateCheckIdSchema>;
export type DecisionGateCheck = z.infer<typeof DecisionGateCheckSchema>;
export type ExperimentDecisionGate = z.infer<typeof ExperimentDecisionGateSchema>;
