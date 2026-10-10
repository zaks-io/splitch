import type {
  DecisionGateCheck,
  ExperimentDecisionGate,
  ExperimentSrmDiagnostics,
  FrozenControlIdentity,
  PersistedSrmAlarm,
  SrmDeviation,
  SrmRootCauseClassification,
  SrmTier,
  StatsOutput,
} from "@splitch/contracts";
import {
  activatedSrmCheck,
  activationBalanceCheck,
  controlIdentityCheck,
  decisionValidCheck,
  engineStatusCheck,
  exposureSrmCheck,
  SRM_CAUTION_P,
  srmIsFiring,
  underpoweredCheck,
} from "./decision-gate-checks";
import { type PlannedDurationEvidence, plannedDurationCheck } from "./decision-gate-duration";
/**
 * Worker-side evaluation of the Experiment ship-decision gate (ADR-0030).
 *
 * Rigor is enforced on the decision, never on the number: this module decides
 * whether "call the experiment" / "promote the winner" is permitted and cites
 * the failing check. Rendering surfaces (Panel, CLI, MCP) transport the result
 * of this function and never recompute it, so every skin refuses identically.
 *
 * There is deliberately no override input. An escape hatch would turn the
 * enforced contract back into an advisory one.
 */

/**
 * The tier the rendering surface shows must be the same verdict the gate
 * enforces, or the page condemns a Run the gate is happy to ship. Both read
 * `srmIsFiring`, so the engine's boolean wins in both places and a payload
 * carrying `srm_is_mismatch: false` with a sub-threshold p-value lands in the
 * caution band rather than being labelled a confirmed mismatch.
 */
export function srmTierFor(pValue: number | null, isMismatch: boolean | null): SrmTier {
  if (srmIsFiring({ pValue, isMismatch })) return "confirmed";
  if (pValue !== null && pValue < SRM_CAUTION_P) return "possible_imbalance";
  return "clean";
}

export function experimentSrmDiagnostics(
  stats: StatsOutput,
  rootCause?: SrmRootCauseClassification | null,
  persistedAlarms: readonly PersistedSrmAlarm[] = [],
): ExperimentSrmDiagnostics {
  const exposureAlarm = alarmFor(persistedAlarms, "exposure");
  const activatedAlarm = alarmFor(persistedAlarms, "activated");
  const exposureMismatch = stats.srm.srm_is_mismatch || exposureAlarm !== undefined;
  const activatedMismatch =
    stats.srm.activated_srm_mismatch === true || activatedAlarm !== undefined;
  const hasActivationGate =
    stats.srm.activated_srm_p_value !== null ||
    stats.srm.activated_srm_mismatch !== null ||
    activatedAlarm !== undefined;
  const hasActivationBalance =
    stats.health.activation_balance_p_value !== null ||
    stats.health.activation_balance_mismatch !== null;
  return {
    exposure: {
      tier: srmTierFor(stats.srm.srm_p_value, exposureMismatch),
      pValue: stats.srm.srm_p_value,
      deviations: srmDeviations(stats.srm.observed_counts, stats.srm.expected_counts),
      ...(exposureAlarm ? { firstCrossedAt: exposureAlarm.firstCrossedAt } : {}),
    },
    activated: hasActivationGate
      ? {
          tier: srmTierFor(stats.srm.activated_srm_p_value, activatedMismatch),
          pValue: stats.srm.activated_srm_p_value,
          deviations: [],
          ...(activatedAlarm ? { firstCrossedAt: activatedAlarm.firstCrossedAt } : {}),
        }
      : null,
    activationBalance: hasActivationBalance
      ? {
          tier: srmTierFor(
            stats.health.activation_balance_p_value,
            stats.health.activation_balance_mismatch,
          ),
          pValue: stats.health.activation_balance_p_value,
        }
      : null,
    ...(rootCause ? { rootCause } : {}),
  };
}

/**
 * OR durable analysis-v2 alarms into Analysis stats for the Control Plane gate
 * and diagnostics. Analysis result tokens stay hashed from the live envelope.
 */
export function overlayPersistedSrmAlarms(
  stats: StatsOutput,
  persistedAlarms: readonly PersistedSrmAlarm[],
): StatsOutput {
  if (persistedAlarms.length === 0) return stats;
  const exposureAlarm = alarmFor(persistedAlarms, "exposure");
  const activatedAlarm = alarmFor(persistedAlarms, "activated");
  if (!exposureAlarm && !activatedAlarm) return stats;
  return {
    ...stats,
    srm: {
      ...stats.srm,
      srm_is_mismatch: stats.srm.srm_is_mismatch || exposureAlarm !== undefined,
      activated_srm_mismatch:
        activatedAlarm !== undefined ? true : stats.srm.activated_srm_mismatch,
    },
  };
}

export function evaluateExperimentDecisionGate(
  stats: StatsOutput,
  control: FrozenControlIdentity,
  duration: PlannedDurationEvidence,
  persistedAlarms: readonly PersistedSrmAlarm[] = [],
): ExperimentDecisionGate {
  const effective = overlayPersistedSrmAlarms(stats, persistedAlarms);
  const srm = experimentSrmDiagnostics(effective, null, persistedAlarms);
  const checks: DecisionGateCheck[] = [
    controlIdentityCheck(control),
    exposureSrmCheck(srm.exposure, effective.srm.srm_is_mismatch),
    activatedSrmCheck(srm.activated, effective.srm.activated_srm_mismatch),
    activationBalanceCheck(srm.activationBalance, effective.health.activation_balance_mismatch),
    engineStatusCheck(effective),
    underpoweredCheck(effective),
    plannedDurationCheck(duration),
    decisionValidCheck(effective),
  ];
  const blockedBy = checks.filter((check) => check.status === "fail").map((check) => check.id);
  return {
    shipAllowed: blockedBy.length === 0,
    blockedBy,
    checks,
    enforcedBy: "control-plane-api",
  };
}

function alarmFor(
  alarms: readonly PersistedSrmAlarm[],
  kind: PersistedSrmAlarm["srmKind"],
): PersistedSrmAlarm | undefined {
  return alarms.find((alarm) => alarm.srmKind === kind);
}

function srmDeviations(
  observed: Record<string, number>,
  expected: Record<string, number>,
): SrmDeviation[] {
  return [...new Set([...Object.keys(observed), ...Object.keys(expected)])]
    .sort()
    .map((variant) => {
      const observedCount = observed[variant] ?? 0;
      const expectedCount = expected[variant] ?? 0;
      return {
        variant,
        observed: observedCount,
        expected: expectedCount,
        delta: observedCount - expectedCount,
      };
    });
}
