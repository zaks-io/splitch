import type { FrozenControlIdentity } from "./experiment-control-identity";
import {
  type ExperimentDecisionGate,
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
import { computeShipRecommendation } from "./ship-recommendation-compute";
import type { SrmRootCauseClassification } from "./srm-root-cause";
import type { AnalysisResultsEnvelope } from "./stats-result-contract";

/**
 * Shared Control Plane result producer (plan 0.15 / 2.4). CLI, MCP, and the
 * panel all read this shape. Analysis still emits the raw envelope; this layer
 * resolves Control identity, lifecycle, duration, permissions, and the ship
 * recommendation before any skin renders a verdict.
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
   * Concise mode omits stats unless this is true (exploratory statistics opt-in,
   * C10 part two). Ignored for detailed (stats always present).
   */
  includeExploratory?: boolean;
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

  const gate = evaluateExperimentDecisionGate(
    input.analysis.stats,
    input.run.control,
    input.run.duration,
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

  const base = readyBase({
    gate,
    readiness,
    reasons,
    analysis: input.analysis,
    run: input.run,
    hasEvidence,
    srmRootCause: input.srmRootCause,
  });

  if (input.view === "concise") {
    return {
      view: "concise",
      ...base,
      ...(input.includeExploratory === true ? { stats: input.analysis.stats } : {}),
    };
  }
  // Detailed keeps Analysis stats byte-identical: same object reference order is
  // not guaranteed after JSON round-trip, but field set and values are unchanged.
  return { view: "detailed", ...base, stats: input.analysis.stats };
}

function readyBase(input: {
  gate: ExperimentDecisionGate;
  readiness: ExperimentResultsReadiness;
  reasons: string[];
  analysis: Extract<AnalysisResultsEnvelope, { state: "ready" }>;
  run: ExperimentResultsRunContext;
  hasEvidence: boolean;
  srmRootCause?: SrmRootCauseClassification | null;
}) {
  const ship = computeShipRecommendation({
    preRegistration: frozenPreRegistration(input.analysis.run_commitments),
    gate: input.gate,
    stats: input.analysis.stats,
  });
  return {
    state: "ready" as const,
    readiness: input.readiness,
    blockedBy: input.gate.blockedBy,
    reasons: input.reasons,
    ...(ship.recommendation !== undefined
      ? { recommendation: ship.recommendation }
      : { recommendationUnavailable: ship.recommendationUnavailable }),
    gate: input.gate,
    run_id: input.analysis.run_id,
    run_number: input.run.runNumber,
    run_status: input.run.runStatus,
    control_variant: input.analysis.control_variant,
    control: input.run.control,
    ...(input.hasEvidence
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
  };
}

function frozenPreRegistration(
  commitments: Extract<AnalysisResultsEnvelope, { state: "ready" }>["run_commitments"],
) {
  if (commitments === undefined || commitments.analysis_version_source !== "frozen") {
    return undefined;
  }
  return commitments.pre_registration;
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
