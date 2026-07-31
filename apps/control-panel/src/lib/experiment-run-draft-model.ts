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

/**
 * Dropping a zero share is intentional — that is how the dialog removes a
 * Variant from the next Run. A non-finite share is not: `NaN > 0` is false, so
 * a blank input would be filtered out here and the Variant would vanish from
 * the staged draft with nothing said. The dialog blocks blanks first; this
 * throws if one ever gets past it, because a silently dropped Variant is a
 * disguised default (ADR-0036).
 */
function positiveAllocation(allocation: Record<string, number>): Record<string, number> {
  const blank = Object.entries(allocation).find(([, share]) => !Number.isFinite(share));
  if (blank) {
    throw new Error(`buildRunStartInput: allocation for "${blank[0]}" is not a finite number`);
  }
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

/**
 * A cleared `<input type="number">` reports `valueAsNumber` as `NaN`, and NaN
 * poisons the sum, so a bare `Math.abs(total - 100) > 1e-6` check evaluates to
 * FALSE and reports no error at all — the Start button would enable and
 * `positiveAllocation` would then drop that Variant from the next Run, since
 * `NaN > 0` is also false. Blank is therefore checked first and named for what
 * it is.
 */
export function allocationError(allocation: Record<string, number>): string | null {
  const shares = Object.values(allocation);
  if (shares.some((share) => !Number.isFinite(share))) {
    return "Every Variant needs a number. Enter 0 to remove one from the next Run.";
  }
  const total = shares.reduce((sum, share) => sum + share, 0);
  return Math.abs(total - 100) > 1e-6
    ? `Allocation must total 100%. It currently totals ${total}%.`
    : null;
}

/**
 * The Start confirmation is the last data-loss gate, so every consequence it
 * names has to be one that has not happened yet. It takes the RUNNING Run, never
 * the Run the form pre-filled from: re-Starting after an End is the common case
 * and there is nothing to abandon in it, and warning an operator about a Run that
 * stopped days ago trains them to click through the warning that is real.
 *
 * It lives here rather than inline in the component because the component only
 * renders inside a Dialog portal, which produces no markup under
 * `renderToStaticMarkup` — the copy would otherwise be untestable.
 */
export function startConfirmationCopy(
  runningRun: PanelExperimentRun | undefined,
  nextRunNumber: number,
): { title: string; description: string; action: string } {
  const freshSample = `Run ${nextRunNumber} starts a fresh sample from zero. Runs are never pooled.`;
  if (!runningRun) {
    return {
      title: "A fresh sample will begin",
      description: freshSample,
      action: `Start Run ${nextRunNumber}`,
    };
  }
  return {
    title: `Run ${runningRun.runNumber} will be abandoned`,
    description: `Run ${runningRun.runNumber} stops accumulating and becomes a frozen archive. ${freshSample}`,
    action: `Abandon Run ${runningRun.runNumber} and Start Run ${nextRunNumber}`,
  };
}

export function targetingRulesError(value: string): string | null {
  try {
    return Array.isArray(JSON.parse(value)) ? null : "Targeting Rules must be a JSON array.";
  } catch {
    return "Targeting Rules must be valid JSON.";
  }
}
