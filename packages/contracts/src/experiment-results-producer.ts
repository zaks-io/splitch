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
  };

  if (input.view === "concise") {
    return { view: "concise", ...base };
  }
  // Detailed keeps Analysis stats byte-identical: same object reference order is
  // not guaranteed after JSON round-trip, but field set and values are unchanged.
  return { view: "detailed", ...base, stats: input.analysis.stats };
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
