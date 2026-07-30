/**
 * The Experiment draft fields an Approval target version hashes. Split out of
 * `approval-target.ts` so that file stays a single-purpose module about target
 * versions and Policy contexts.
 */
export function experimentTargetProjection(
  experiment: Record<string, unknown>,
): Record<string, unknown> {
  return {
    id: experiment.id,
    flagId: experiment.flagId,
    targetingKeyField: experiment.targetingKeyField,
    targetingKeyType: experiment.targetingKeyType,
    confidenceLevel: experiment.confidenceLevel,
    defaultVariantId: experiment.defaultVariantId,
    metrics: parseJson(experiment.metrics),
    guardrailMetrics: parseJson(experiment.guardrailMetrics),
    activationMetricId: experiment.activationMetricId,
    conversionWindowMs: experiment.conversionWindowMs,
    dimensions: parseJson(experiment.dimensions),
    draftAllocation: parseJson(experiment.draftAllocation),
    draftSalt: experiment.draftSalt,
    draftTargetingRules: parseJson(experiment.draftTargetingRules),
    draftSegmentIds: parseJson(experiment.draftSegmentIds),
    liveRunId: experiment.liveRunId,
  };
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return value ?? null;
  return JSON.parse(value) as unknown;
}
