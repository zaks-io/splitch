/**
 * The Experiment-creation draft: the fields an operator fills in BEFORE Run 1 is
 * opened, and the per-field verdicts on them.
 *
 * Every step here writes to the real `draft` Experiment through the ordinary
 * Experiment create/PATCH endpoints, so leaving mid-flow and coming back loses
 * nothing. Run 1 itself is opened by the shared draft → Start mechanism
 * (`useExperimentRunStart`), never by anything defined here.
 */

export const EXPERIMENT_DRAFT_STEPS = ["measurement", "decision", "run"] as const;
export type ExperimentDraftStep = (typeof EXPERIMENT_DRAFT_STEPS)[number];

export const EXPERIMENT_DRAFT_STEP_LABELS: Record<ExperimentDraftStep, string> = {
  measurement: "Metrics",
  decision: "Decision spec",
  run: "Run",
};

export function isExperimentDraftStep(value: unknown): value is ExperimentDraftStep {
  return (EXPERIMENT_DRAFT_STEPS as readonly unknown[]).includes(value);
}

export interface ExperimentBasicsDraft {
  name: string;
  key: string;
  flagId: string;
  targetingKey: string;
  targetingKeyType: string;
}

export type FieldIssues<Draft> = { [Key in keyof Draft]: string | null };

export function experimentBasicsIssues(
  draft: ExperimentBasicsDraft,
): FieldIssues<ExperimentBasicsDraft> {
  return {
    name: draft.name.trim() ? null : "Name this Experiment.",
    key: keyIssue(draft.key),
    flagId: draft.flagId ? null : "Choose the Flag this Experiment controls.",
    targetingKey: draft.targetingKey.trim()
      ? null
      : "A Targeting Key is required: it is the field traffic is bucketed on.",
    targetingKeyType: draft.targetingKeyType.trim()
      ? null
      : "An Entity type is required: it names what the Targeting Key identifies.",
  };
}

function keyIssue(key: string): string | null {
  const trimmed = key.trim();
  if (!trimmed) return "A key is required. It is unique per App and Environment.";
  return /^[a-z0-9][a-z0-9._-]*$/.test(trimmed)
    ? null
    : "Use lowercase letters, digits, dots, dashes, or underscores.";
}

export function hasIssue(issues: Record<string, string | null>): boolean {
  return Object.values(issues).some((issue) => issue !== null);
}

export function buildCreateExperimentInput(
  scope: { appId: string; environmentId: string },
  draft: ExperimentBasicsDraft,
  idempotencyKey: string,
) {
  return {
    appId: scope.appId,
    environmentId: scope.environmentId,
    name: draft.name.trim(),
    key: draft.key.trim(),
    flagId: draft.flagId,
    targetingKey: draft.targetingKey.trim(),
    targetingKeyType: draft.targetingKeyType.trim(),
    // The Experiment is created with an empty goal Metric family on purpose: the
    // next step chooses it. Start is what refuses an empty family, because Start
    // is the last moment it is still fixable (ADR-0003).
    metrics: [],
    idempotency_key: idempotencyKey,
  };
}

/**
 * The Activation Metric is deliberately NOT here. It is collected once, in the
 * shared Run draft fields, because it is staged onto the Run alongside the rest
 * of the assignment config; collecting it twice would let this step overwrite
 * the Run step's choice with a null on the way back through.
 */
export interface MeasurementDraft {
  metricIds: string[];
  guardrailMetricIds: string[];
  conversionHours: string;
}

export function measurementIssues(draft: MeasurementDraft): FieldIssues<MeasurementDraft> {
  const overlap = draft.metricIds.filter((id) => draft.guardrailMetricIds.includes(id));
  // `Number("")` is 0, so a blank field would silently mean "no conversion
  // window" — a measurement decision the operator never made.
  const hours = draft.conversionHours.trim() === "" ? Number.NaN : Number(draft.conversionHours);
  return {
    metricIds:
      draft.metricIds.length > 0
        ? null
        : "Choose at least one goal Metric. Start freezes the goal Metric family into the Run, and every Metric added afterwards is exploratory for that Run.",
    guardrailMetricIds:
      overlap.length > 0
        ? "A Metric cannot be both a goal and a Guardrail: the same Metric would be read once as evidence for the change and once as a reason to stop it."
        : null,
    conversionHours:
      Number.isFinite(hours) && hours >= 0
        ? null
        : "Enter a conversion window in hours (0 or more).",
  };
}

export function buildMeasurementPatch(draft: MeasurementDraft) {
  return {
    metrics: draft.metricIds.map((metricId) => ({ metricId })),
    guardrailMetrics: draft.guardrailMetricIds.map((metricId) => ({ metricId })),
    conversionWindowMs: Math.round(Number(draft.conversionHours) * 3_600_000),
  };
}

export interface DecisionDraft {
  confidenceLevel: string;
  dimensions: string;
}

export function decisionIssues(draft: DecisionDraft): FieldIssues<DecisionDraft> {
  const confidence = Number(draft.confidenceLevel);
  return {
    confidenceLevel:
      Number.isFinite(confidence) && confidence > 0.5 && confidence < 1
        ? null
        : "Confidence level must be between 0.5 and 1 (0.95 is the usual choice).",
    dimensions: null,
  };
}

export function buildDecisionPatch(draft: DecisionDraft) {
  return {
    confidenceLevel: Number(draft.confidenceLevel),
    dimensions: splitDimensions(draft.dimensions),
  };
}

/**
 * Primary Dimensions are pre-registered so a later slice is a declared cut and
 * not a fishing expedition. Blank entries are dropped rather than sent as empty
 * Dimension names.
 */
export function splitDimensions(value: string): string[] {
  return value
    .split(",")
    .map((dimension) => dimension.trim())
    .filter((dimension) => dimension.length > 0);
}
