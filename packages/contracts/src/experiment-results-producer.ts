import type { FrozenControlIdentity } from "./experiment-control-identity";
import {
  type ExperimentDecisionGate,
  type PersistedSrmAlarm,
  evaluateExperimentDecisionGate,
} from "./experiment-decision-gate";
import type { PlannedDurationEvidence } from "./experiment-decision-gate-duration";
import {
  type ExperimentResultsReadiness,
  type ExperimentResultsView,
  reasonsFromChecks,
  statisticalReadiness,
} from "./experiment-results-readiness";
import type { ExperimentResultsResponse } from "./experiment-results-response";
import type { SrmRootCauseClassification } from "./srm-root-cause";
import type { AnalysisResultsEnvelope } from "./stats-result-contract";

/**
 * Shared Control Plane result producer (plan 0.15). CLI, MCP, and the panel
 * all read this shape. Analysis still emits the raw envelope; this layer
 * resolves Control identity, lifecycle, duration, and permissions into
 * readiness before any skin renders a verdict.
 */

export interface ExperimentResultsRunContext {
  runNumber: number;
  /** `running` or `ended` only; other D1 statuses are mapped by the caller. */
  runStatus: "running" | "ended";
  control: FrozenControlIdentity;
  duration: PlannedDurationEvidence;
}

export interface ProduceExperimentResultsInput {
  view: ExperimentResultsView;
  analysis: AnalysisResultsEnvelope;
  /** Null only for `state: "no_run"` (draft Experiment, never Started). */
  run: ExperimentResultsRunContext | null;
  /** Whether this caller may invoke Conclude (App owner/admin). */
  canConclude: boolean;
  /**
   * Precomputed Fabijan root-cause from `@splitch/stats`. The producer cannot
   * import stats (contracts ← stats dependency direction), so the Control Plane
   * enrich seam classifies and passes the result. Omit or null when SRM is clean.
   */
  srmRootCause?: SrmRootCauseClassification | null;
  /**
   * Durable analysis-v2 SRM alarms from D1. ORed into the gate and detailed
   * stats mismatch flags. v1/legacy callers omit this.
   */
  persistedSrmAlarms?: readonly PersistedSrmAlarm[];
}

const NOT_READY: ExperimentResultsReadiness = {
  statistical: false,
  concludeExecutable: false,
};

export function produceExperimentResults(
  input: ProduceExperimentResultsInput,
): ExperimentResultsResponse {
  if (input.analysis.state === "no_run") {
    return {
      view: input.view,
      state: "no_run",
      readiness: NOT_READY,
      blockedBy: [],
      reasons: ["No Run has been Started for this Experiment. Call experiments_start."],
      recommended_action: "START_A_RUN",
    };
  }

  if (input.run === null) {
    throw new Error("produceExperimentResults requires run context when Analysis is not no_run");
  }

  if (input.analysis.state === "no_data") {
    return {
      view: input.view,
      state: "no_data",
      readiness: NOT_READY,
      blockedBy: [],
      reasons: [noDataReason(input.analysis.missing)],
      run_id: input.analysis.run_id,
      run_number: input.run.runNumber,
      run_status: input.run.runStatus,
      control_variant: input.analysis.control_variant,
      control: input.run.control,
      missing: input.analysis.missing,
    };
  }

  const persistedSrmAlarms = input.persistedSrmAlarms ?? [];
  const gate = evaluateExperimentDecisionGate(
    input.analysis.stats,
    input.run.control,
    input.run.duration,
    persistedSrmAlarms,
  );
  const hasEvidence =
    input.analysis.data_watermark !== undefined && input.analysis.result_token !== undefined;
  const readiness = readyReadiness({
    gate,
    runStatus: input.run.runStatus,
    hasEvidence,
    canConclude: input.canConclude,
  });
  const reasons = [
    ...reasonsFromChecks(gate.checks),
    ...concludeBlockReasons({
      runStatus: input.run.runStatus,
      hasEvidence,
      canConclude: input.canConclude,
    }),
  ];

  const base = {
    state: "ready" as const,
    readiness,
    blockedBy: gate.blockedBy,
    reasons,
    gate,
    run_id: input.analysis.run_id,
    run_number: input.run.runNumber,
    run_status: input.run.runStatus,
    control_variant: input.analysis.control_variant,
    control: input.run.control,
    ...(hasEvidence
      ? {
          data_watermark: input.analysis.data_watermark,
          result_token: input.analysis.result_token,
        }
      : {}),
    ...(input.analysis.run_commitments !== undefined
      ? { run_commitments: input.analysis.run_commitments }
      : {}),
    // Additive diagnostics only: never hashed into result_token (stats unchanged).
    ...(input.srmRootCause ? { srm_root_cause: input.srmRootCause } : {}),
    ...(persistedSrmAlarms.length > 0 ? { persisted_srm_alarms: [...persistedSrmAlarms] } : {}),
  };

  if (input.view === "concise") {
    return { view: "concise", ...base };
  }
  // Detailed stats stay byte-identical to Analysis (result_token binding).
  // Durable alarms apply only through the gate, diagnostics, and
  // persisted_srm_alarms — never by rewriting stats.srm mismatch flags.
  return {
    view: "detailed",
    ...base,
    stats: input.analysis.stats,
  };
}

function readyReadiness(input: {
  gate: ExperimentDecisionGate;
  runStatus: "running" | "ended";
  hasEvidence: boolean;
  canConclude: boolean;
}): ExperimentResultsReadiness {
  const statistical = statisticalReadiness(input.gate.checks);
  const concludeExecutable =
    input.gate.shipAllowed &&
    input.runStatus === "running" &&
    input.hasEvidence &&
    input.canConclude;
  return { statistical, concludeExecutable };
}

function concludeBlockReasons(input: {
  runStatus: "running" | "ended";
  hasEvidence: boolean;
  canConclude: boolean;
}): string[] {
  // Gate failures already appear via reasonsFromChecks; only name lifecycle,
  // evidence-handle, and permission blockers that the gate does not cover.
  const reasons: string[] = [];
  if (input.runStatus !== "running") {
    reasons.push("Conclude requires a running Run; this Run has already ended.");
  }
  if (!input.hasEvidence) {
    reasons.push(
      "Conclude requires data_watermark and result_token on the selected evidence; this read has neither.",
    );
  }
  if (!input.canConclude) {
    reasons.push("Conclude requires App owner or admin membership for this caller.");
  }
  return reasons;
}

function noDataReason(missing: "exposures" | "metric_events"): string {
  if (missing === "exposures") {
    return "No Exposures have been observed for this Run yet.";
  }
  return "No Metric Events have been observed for this Run yet.";
}
