import type {
  PanelExperimentDetailOutput,
  PanelExperimentRun,
} from "@splitch/control-plane-sdk/panel-experiments";

export function initialRunDraft(
  data: PanelExperimentDetailOutput,
  run: PanelExperimentRun | undefined,
) {
  const variantNames = new Set([
    ...data.variants.map((variant) => variant.name),
    ...Object.keys(run?.allocation ?? data.experiment.draftAllocation ?? {}),
  ]);
  const baseAllocation = run?.allocation ?? data.experiment.draftAllocation ?? {};
  const allocation = Object.fromEntries(
    [...variantNames].map((name) => [name, baseAllocation[name] ?? 0]),
  );
  return {
    allocation: Object.keys(allocation).length > 0 ? allocation : { control: 100 },
    targetingKey: run?.targetingKey ?? data.experiment.targetingKey,
    targetingKeyType: run?.targetingKeyType ?? data.experiment.targetingKeyType,
    activationMetricId: run?.activationMetricId ?? data.experiment.activationMetricId ?? "",
    targetingRules: run?.targetingRulesJson ?? data.experiment.draftTargetingRulesJson ?? "[]",
  };
}

function positiveAllocation(allocation: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(allocation).filter(([, share]) => share > 0));
}

export function buildRunStartInput({
  activationMetricId,
  allocation,
  appId,
  environmentId,
  experimentId,
  idempotencyKey,
  reason,
  salt,
  targetingKey,
  targetingKeyType,
  targetingRules,
}: {
  activationMetricId: string;
  allocation: Record<string, number>;
  appId: string;
  environmentId: string;
  experimentId: string;
  idempotencyKey: string;
  reason: string;
  salt: string;
  targetingKey: string;
  targetingKeyType: string;
  targetingRules: unknown[];
}) {
  const saltOverride = salt.trim();
  const startReason = reason.trim();
  return {
    appId,
    environmentId,
    experimentId,
    draft: {
      allocation: positiveAllocation(allocation),
      targetingKey: targetingKey.trim(),
      targetingKeyType: targetingKeyType.trim(),
      activationMetricId: activationMetricId || null,
      targetingRules,
      ...(saltOverride ? { salt: saltOverride } : {}),
    },
    start: {
      idempotency_key: idempotencyKey,
      review: { action: "approve_and_apply" as const },
      ...(startReason ? { reason: startReason } : {}),
    },
  };
}

export function targetingRulesError(value: string): string | null {
  try {
    return Array.isArray(JSON.parse(value)) ? null : "Targeting Rules must be a JSON array.";
  } catch {
    return "Targeting Rules must be valid JSON.";
  }
}
