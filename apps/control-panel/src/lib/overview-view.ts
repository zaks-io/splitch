import type {
  OverviewDecisionReason,
  OverviewExperiments,
  OverviewExperimentsUnavailableReason,
  OverviewFailureReason,
} from "@splitch/contracts";

const DECISION_REASON_LABELS: Record<OverviewDecisionReason, string> = {
  significance_reached: "Significance reached",
  horizon_reached: "Horizon reached",
};

const FAILURE_REASON_LABELS: Record<OverviewFailureReason, string> = {
  srm_firing: "SRM firing",
  guardrail_breached: "Guardrail breached",
  multiple_assignment_quarantine: "Multiple assignment",
};

export function decisionReasonLabel(reason: OverviewDecisionReason): string {
  return DECISION_REASON_LABELS[reason];
}

export function failureReasonLabel(reason: OverviewFailureReason): string {
  return FAILURE_REASON_LABELS[reason];
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * Renders a change timestamp in UTC. Deliberately not locale- or clock-relative:
 * the loader renders on the server and hydrates on the client, and a value that
 * depends on either would disagree across that boundary.
 */
export function changedAtLabel(iso: string): string {
  const changedAt = new Date(iso);
  if (Number.isNaN(changedAt.getTime())) throw new Error(`unreadable change timestamp: ${iso}`);
  const day = String(changedAt.getUTCDate()).padStart(2, "0");
  const hours = String(changedAt.getUTCHours()).padStart(2, "0");
  const minutes = String(changedAt.getUTCMinutes()).padStart(2, "0");
  return `${day} ${MONTHS[changedAt.getUTCMonth()]} ${changedAt.getUTCFullYear()}, ${hours}:${minutes} UTC`;
}

export interface ExperimentsUnavailableCopy {
  title: string;
  description: string;
  retryable: boolean;
}

const UNAVAILABLE_COPY: Record<
  OverviewExperimentsUnavailableReason,
  { title: string; description: string }
> = {
  analysis_unavailable: {
    title: "Experiment attention is unknown",
    description:
      "The Analysis read failed, so this is not a clean bill of health. Refresh to try again.",
  },
  experiment_integrity: {
    title: "Experiment attention is unknown",
    description:
      "A running Experiment has no live Run. Refreshing will not clear this; the Experiment record has to be repaired.",
  },
  read_budget_exceeded: {
    title: "Experiment attention is unknown",
    description:
      "This Environment has more running Experiments than the Overview reads at once. Refreshing will not clear this; review them from the Experiments section.",
  },
};

/**
 * Copy for a section that could not be read.
 *
 * The retry offer is driven by the Worker's own `retryable` verdict, never by the
 * reason string, so the Panel cannot invite an operator to retry a fault that no
 * retry repairs (ADR-0036).
 */
export function experimentsUnavailableCopy(
  experiments: Extract<OverviewExperiments, { status: "unavailable" }>,
): ExperimentsUnavailableCopy {
  return { ...UNAVAILABLE_COPY[experiments.reason], retryable: experiments.retryable };
}

/**
 * True only when every section was read successfully AND every one of them is
 * empty. An unavailable section can never produce the calm empty state, because
 * "nothing needs you" and "we could not look" are different answers — and neither
 * can a running Experiment with no Analysis result, because "not yet" is a third.
 */
export function isCalmOverview(input: {
  experiments: OverviewExperiments;
  recentlyChanged: readonly unknown[];
}): boolean {
  if (input.experiments.status !== "ok") return false;
  return (
    input.experiments.needingDecision.length === 0 &&
    input.experiments.failing.length === 0 &&
    input.experiments.noData.length === 0 &&
    input.recentlyChanged.length === 0
  );
}
