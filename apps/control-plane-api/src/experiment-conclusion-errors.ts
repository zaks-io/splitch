import type {
  DecisionFailure,
  ExperimentDecisionGate,
  FrozenControlIdentity,
  StatsOutput,
} from "@splitch/contracts";
import type { PlannedDurationEvidence } from "@splitch/stats";
import {
  decisionValidMembers,
  earliestDecisionWatermark,
  observedEvidenceDays,
} from "@splitch/stats";
import { renderError } from "@splitch/worker-runtime";

export function decisionResultUnavailable(
  runId: string,
  envelopeState: "ready" | "no_data" | "no_run",
  requestId: string,
): Response {
  return renderError(
    {
      code: "DECISION_RESULT_UNAVAILABLE",
      message: "Run results are unavailable for conclusion",
      details: { runId, envelopeState },
    },
    { requestId },
  );
}

export function decisionResultStale(
  runId: string,
  expectedResultToken: `sha256:${string}`,
  currentResultToken: `sha256:${string}`,
  requestId: string,
): Response {
  return renderError(
    {
      code: "DECISION_RESULT_STALE",
      message: "Run results changed at the selected evidence boundary",
      details: { runId, expectedResultToken, currentResultToken },
    },
    { requestId },
  );
}

export function targetConfigurationStale(
  flagId: string,
  environmentId: string,
  expectedConfigVersion: number,
  currentConfigVersion: number,
  requestId: string,
): Response {
  return renderError(
    {
      code: "TARGET_CONFIGURATION_STALE",
      message: "target Flag Configuration changed",
      details: {
        flagId,
        environmentId,
        expectedConfigVersion,
        currentConfigVersion,
        recommendedAction: "REFRESH_AND_REPROPOSE",
      },
    },
    { requestId },
  );
}

export function conclusionProjectionUnavailable(
  conclusionId: string,
  approvalRequestId: string,
  requestId: string,
): Response {
  return renderError(
    {
      code: "SERVICE_UNAVAILABLE",
      message: "Run conclusion committed but its edge projection could not be refreshed",
      details: {
        retryAfterMs: 1000,
        mutationCommitted: true,
        conclusionId,
        approvalRequestId,
      },
    },
    { requestId },
  );
}

export function decisionBlocked(
  runId: string,
  resultToken: `sha256:${string}`,
  dataWatermark: string,
  stats: StatsOutput,
  control: FrozenControlIdentity,
  duration: PlannedDurationEvidence,
  gate: ExperimentDecisionGate,
  requestId: string,
): Response {
  return renderError(
    {
      code: "DECISION_BLOCKED",
      message: `Run conclusion is blocked: ${gate.checks
        .filter((check) => check.status === "fail")
        .map((check) => check.title)
        .join("; ")}`,
      details: {
        runId,
        resultToken,
        dataWatermark,
        failures: decisionFailures(stats, control, duration, gate),
      },
    },
    { requestId },
  );
}

function decisionFailures(
  stats: StatsOutput,
  control: FrozenControlIdentity,
  duration: PlannedDurationEvidence,
  gate: ExperimentDecisionGate,
): DecisionFailure[] {
  const failed = new Set(
    gate.checks.filter((check) => check.status === "fail").map(({ id }) => id),
  );
  const failures: DecisionFailure[] = [];
  if (failed.has("control_identity")) failures.push(controlFailure(control));
  const invalidIds = (["engine_status", "decision_valid_result"] as const).filter((id) =>
    failed.has(id),
  );
  if (invalidIds.length > 0) {
    failures.push({
      code: "DECISION_RESULT_INVALID",
      checkIds: invalidIds as
        | ["engine_status"]
        | ["decision_valid_result"]
        | ["engine_status", "decision_valid_result"],
      details: { members: resultMembers(stats, (status) => status === "error") },
    });
  }
  if (failed.has("underpowered")) {
    failures.push({
      code: "DECISION_UNDERPOWERED",
      checkIds: ["underpowered"],
      details: {
        members: resultMembers(stats, (status) => !["ready", "stopped", "error"].includes(status)),
        lowN: stats.health.low_n_warning,
      },
    });
  }
  const srmIds = (["exposure_srm", "activated_srm"] as const).filter((id) => failed.has(id));
  if (srmIds.length > 0) {
    failures.push({
      code: "DECISION_SRM_MISMATCH",
      checkIds: srmIds as ["exposure_srm"] | ["activated_srm"] | ["exposure_srm", "activated_srm"],
      details: {
        pValues: {
          ...(failed.has("exposure_srm") ? { exposure_srm: stats.srm.srm_p_value } : {}),
          ...(failed.has("activated_srm")
            ? { activated_srm: stats.srm.activated_srm_p_value }
            : {}),
        },
      },
    });
  }
  if (failed.has("planned_duration")) failures.push(durationFailure(duration));
  if (failed.has("activation_balance")) {
    failures.push({
      code: "DECISION_ACTIVATION_IMBALANCE",
      checkIds: ["activation_balance"],
      details: {
        pValue: stats.health.activation_balance_p_value,
        rates: stats.health.activation_rates,
      },
    });
  }
  return failures;
}

function resultMembers(stats: StatsOutput, include: (status: string) => boolean) {
  return decisionValidMembers(stats)
    .map(({ result }) => ({
      metricId: result.metric_id,
      variant: result.variant,
      status: result.status,
    }))
    .filter(({ status }) => include(status));
}

/**
 * Conclude always carries a watermark, so a failed duration check here is
 * always a short window, never a missing one.
 */
function durationFailure(duration: PlannedDurationEvidence): DecisionFailure {
  const { plannedDurationDays, dataWatermark } = duration;
  if (plannedDurationDays === null || dataWatermark === null) {
    throw new Error("a failed planned_duration check needs a planned duration and a watermark");
  }
  return {
    code: "DECISION_DURATION_INCOMPLETE",
    checkIds: ["planned_duration"],
    details: {
      plannedDurationDays,
      observedDays: observedEvidenceDays(duration.runStartedAt, dataWatermark),
      runStartedAt: duration.runStartedAt,
      earliestDecisionWatermark: earliestDecisionWatermark(
        duration.runStartedAt,
        plannedDurationDays,
      ),
      overrideReason: duration.overrideReason,
    },
  };
}

function controlFailure(control: FrozenControlIdentity): DecisionFailure {
  if (control.state === "frozen") {
    throw new Error("a frozen Control cannot produce a failed control identity check");
  }
  return {
    code: "DECISION_CONTROL_IDENTITY_INVALID",
    checkIds: ["control_identity"],
    details:
      control.state === "unresolvable"
        ? {
            controlVariantId: control.variantId,
            frozenVariantNames: control.frozenVariantNames,
            reason: control.reason,
          }
        : {
            controlVariantId: control.variantId,
            frozenVariantNames: [control.variant],
            reason: "analysis_control_disagreement",
          },
  };
}
