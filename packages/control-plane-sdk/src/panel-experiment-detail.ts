import { type Metric, MetricSchema, VariantSchema } from "@splitch/contracts";

export interface PanelExperimentDetailInput {
  appId: string;
  environmentId: string;
  experimentId: string;
}

export interface PanelExperimentRun {
  id: string;
  experimentId: string;
  environmentId: string;
  runNumber: number;
  status: "ended" | "running";
  targetingKey: string;
  targetingKeyType: string;
  activationMetricId: string | null;
  salt: string;
  allocation: Record<string, number>;
  controlVariantId: string;
  variantsJson: string;
  targetingRulesJson: string;
  targetN: number | null;
  decisionFamilyJson: string;
  guardrailDecisionsJson: string;
  metricVarianceConfigJson: string;
  decisionMetricIds: string[];
  decisionGuardrailMetricIds: string[];
  /** The decision spec this Run froze at Start (ADR-0003). Never editable after. */
  confidenceLevel: number;
  horizon: "sequential" | "fixed";
  sampleSizeLocked: number | null;
  configHash: string;
  startedAt: string;
  endedAt: string | null;
  startReason: string | null;
  endReason: string | null;
  createdAt: string;
}

export interface PanelExperimentDetail {
  id: string;
  /** Stable Experiment identity shared by corresponding rows across Environments. */
  key: string;
  name: string;
  description: string;
  owner: string;
  tags: string[];
  status: "draft" | "running" | "ended";
  flagId: string;
  targetingKey: string;
  targetingKeyType: string;
  activationMetricId: string | null;
  conversionWindowMs: number;
  confidenceLevel: number;
  dimensions: string[];
  metricIds: string[];
  guardrailMetricIds: string[];
  draftAllocation: Record<string, number> | null;
  draftSalt: string | null;
  draftTargetingRulesJson: string | null;
  /**
   * Segment references staged for the next Run. A Run freezes the Targeting
   * Rules these resolve to, not the references themselves, so the Experiment's
   * staged list is the only readable record of them.
   */
  draftSegmentIds: string[];
  liveRunId: string | null;
}

export interface PanelExperimentDetailOutput {
  experiment: PanelExperimentDetail;
  flag: { id: string; key: string; name: string };
  metrics: Metric[];
  eventDefinitions: Array<{ id: string; name: string }>;
  variants: Array<{ id: string; name: string }>;
  runs: PanelExperimentRun[];
}

export function parsePanelExperimentDetailOutput(input: unknown) {
  if (
    !isObject(input) ||
    !isObject(input.flag) ||
    !Array.isArray(input.metrics) ||
    !Array.isArray(input.eventDefinitions) ||
    !Array.isArray(input.variants) ||
    !Array.isArray(input.runs)
  ) {
    return { success: false as const };
  }
  const experiment = parsePanelExperimentDetail(input.experiment);
  const metrics = input.metrics.map((metric) => {
    const parsed = MetricSchema.safeParse(metric);
    return parsed.success ? parsed.data : null;
  });
  const eventDefinitions = input.eventDefinitions.map(parseMetric);
  const variants = input.variants.map(parseMetric);
  const runs = input.runs.map(parsePanelExperimentRun);
  if (
    experiment === null ||
    !isNonEmptyString(input.flag.id) ||
    !isNonEmptyString(input.flag.key) ||
    !isNonEmptyString(input.flag.name) ||
    metrics.some((metric) => metric === null) ||
    eventDefinitions.some((definition) => definition === null) ||
    variants.some((variant) => variant === null) ||
    runs.some((run) => run === null)
  ) {
    return { success: false as const };
  }
  return {
    success: true as const,
    data: {
      experiment,
      flag: { id: input.flag.id, key: input.flag.key, name: input.flag.name },
      metrics,
      eventDefinitions,
      variants,
      runs,
    } as PanelExperimentDetailOutput,
  };
}

function parsePanelExperimentRun(input: unknown): PanelExperimentRun | null {
  if (
    !isObject(input) ||
    !isNonEmptyString(input.id) ||
    !isNonEmptyString(input.experimentId) ||
    !isNonEmptyString(input.environmentId) ||
    !Number.isInteger(input.runNumber) ||
    Number(input.runNumber) < 1 ||
    !isRunStatus(input.status) ||
    !isNonEmptyString(input.targetingKey) ||
    !isNonEmptyString(input.targetingKeyType) ||
    !isNullableString(input.activationMetricId) ||
    !isNonEmptyString(input.salt) ||
    !isAllocation(input.allocation) ||
    !isNonEmptyString(input.controlVariantId) ||
    !isVariantArrayJson(input.variantsJson) ||
    !isJsonArray(input.targetingRulesJson) ||
    !(input.targetN === null || (Number.isInteger(input.targetN) && Number(input.targetN) >= 0)) ||
    !isJsonArray(input.decisionFamilyJson) ||
    !isJsonArray(input.guardrailDecisionsJson) ||
    !isJsonArray(input.metricVarianceConfigJson) ||
    !isStringArray(input.decisionMetricIds) ||
    !isStringArray(input.decisionGuardrailMetricIds) ||
    typeof input.confidenceLevel !== "number" ||
    !isRunHorizon(input.horizon) ||
    !(input.sampleSizeLocked === null || Number.isInteger(input.sampleSizeLocked)) ||
    !isNonEmptyString(input.configHash) ||
    !isNonEmptyString(input.startedAt) ||
    !isOptionalString(input.endedAt) ||
    !isOptionalString(input.startReason) ||
    !isOptionalString(input.endReason) ||
    !isNonEmptyString(input.createdAt)
  ) {
    return null;
  }
  return {
    id: input.id,
    experimentId: input.experimentId,
    environmentId: input.environmentId,
    runNumber: Number(input.runNumber),
    status: input.status,
    targetingKey: input.targetingKey,
    targetingKeyType: input.targetingKeyType,
    activationMetricId: input.activationMetricId,
    salt: input.salt,
    allocation: input.allocation,
    controlVariantId: input.controlVariantId,
    variantsJson: input.variantsJson,
    targetingRulesJson: input.targetingRulesJson,
    targetN: input.targetN === null ? null : Number(input.targetN),
    decisionFamilyJson: input.decisionFamilyJson,
    guardrailDecisionsJson: input.guardrailDecisionsJson,
    metricVarianceConfigJson: input.metricVarianceConfigJson,
    decisionMetricIds: input.decisionMetricIds,
    decisionGuardrailMetricIds: input.decisionGuardrailMetricIds,
    confidenceLevel: input.confidenceLevel,
    horizon: input.horizon,
    sampleSizeLocked: input.sampleSizeLocked === null ? null : Number(input.sampleSizeLocked),
    configHash: input.configHash,
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    startReason: input.startReason,
    endReason: input.endReason,
    createdAt: input.createdAt,
  };
}

function parsePanelExperimentDetail(input: unknown): PanelExperimentDetail | null {
  if (
    !isObject(input) ||
    !isNonEmptyString(input.id) ||
    !isNonEmptyString(input.key) ||
    !isNonEmptyString(input.name) ||
    typeof input.description !== "string" ||
    typeof input.owner !== "string" ||
    !isStringArray(input.tags) ||
    !isLifecycle(input.status) ||
    !isNonEmptyString(input.flagId) ||
    !isNonEmptyString(input.targetingKey) ||
    !isNonEmptyString(input.targetingKeyType) ||
    !isNullableString(input.activationMetricId) ||
    typeof input.conversionWindowMs !== "number" ||
    !Number.isFinite(input.conversionWindowMs) ||
    typeof input.confidenceLevel !== "number" ||
    !Number.isFinite(input.confidenceLevel) ||
    !isStringArray(input.dimensions) ||
    !isStringArray(input.metricIds) ||
    !isStringArray(input.guardrailMetricIds) ||
    !isNullableAllocation(input.draftAllocation) ||
    !isNullableString(input.draftSalt) ||
    !isNullableJsonArray(input.draftTargetingRulesJson) ||
    !isStringArray(input.draftSegmentIds) ||
    !(input.liveRunId === null || isNonEmptyString(input.liveRunId))
  ) {
    return null;
  }
  return {
    id: input.id,
    key: input.key,
    name: input.name,
    description: input.description,
    owner: input.owner,
    tags: input.tags,
    status: input.status,
    flagId: input.flagId,
    targetingKey: input.targetingKey,
    targetingKeyType: input.targetingKeyType,
    activationMetricId: input.activationMetricId,
    conversionWindowMs: input.conversionWindowMs,
    confidenceLevel: input.confidenceLevel,
    dimensions: input.dimensions,
    metricIds: input.metricIds,
    guardrailMetricIds: input.guardrailMetricIds,
    draftAllocation: input.draftAllocation,
    draftSalt: input.draftSalt,
    draftTargetingRulesJson: input.draftTargetingRulesJson,
    draftSegmentIds: input.draftSegmentIds,
    liveRunId: input.liveRunId,
  };
}

function parseMetric(input: unknown): { id: string; name: string } | null {
  return isObject(input) && isNonEmptyString(input.id) && isNonEmptyString(input.name)
    ? { id: input.id, name: input.name }
    : null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isOptionalString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

const isNullableString = isOptionalString;

function isRunStatus(value: unknown): value is PanelExperimentRun["status"] {
  return value === "ended" || value === "running";
}

function isRunHorizon(value: unknown): value is PanelExperimentRun["horizon"] {
  return value === "sequential" || value === "fixed";
}

function isAllocation(value: unknown): value is Record<string, number> {
  return (
    isObject(value) &&
    Object.values(value).every((share) => typeof share === "number" && Number.isFinite(share))
  );
}

function isNullableAllocation(value: unknown): value is Record<string, number> | null {
  return value === null || isAllocation(value);
}

function isVariantArrayJson(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((item) => VariantSchema.safeParse(item).success);
  } catch {
    return false;
  }
}

function isJsonArray(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    return Array.isArray(JSON.parse(value));
  } catch {
    return false;
  }
}

function isNullableJsonArray(value: unknown): value is string | null {
  return value === null || isJsonArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isLifecycle(value: unknown): value is PanelExperimentDetail["status"] {
  return value === "draft" || value === "running" || value === "ended";
}
