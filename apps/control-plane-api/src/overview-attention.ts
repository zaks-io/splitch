import {
  lockedFamilyMembers,
  type OverviewDecisionExperiment,
  type OverviewDecisionReason,
  type OverviewExperiments,
  type OverviewFailingExperiment,
  type OverviewFailureReason,
  type StatsOutput,
} from "@splitch/contracts";
import { guardrailBreached, srmFiring } from "@splitch/control-plane-sdk/panel-experiments";
import { MULTIPLE_ASSIGNMENT_RATE_THRESHOLD } from "./overview-thresholds";

/** The identity of one running Experiment, as the Overview wire shape carries it. */
type OverviewExperimentRef = Extract<OverviewExperiments, { status: "ok" }>["noData"][number];

/** One running Experiment plus the Run facts and Analysis the classifier needs. */
interface OverviewExperimentRead extends OverviewExperimentRef {
  state: "read";
  horizon: string;
  sampleSizeLocked: number | null;
  stats: StatsOutput;
}

/**
 * A running Experiment Analysis has no result for yet. Kept as its own state
 * rather than dropped, because "we have no numbers" is not "nothing to see".
 */
interface OverviewExperimentNoData extends OverviewExperimentRef {
  state: "no_data";
}

export type OverviewExperimentReading = OverviewExperimentRead | OverviewExperimentNoData;

export interface OverviewClassification {
  needingDecision: OverviewDecisionExperiment[];
  failing: OverviewFailingExperiment[];
  noData: OverviewExperimentRef[];
}

/**
 * Splits running Experiments into "needs a decision" and "is failing".
 *
 * An Experiment can appear in both: a Run can be statistically ready and also
 * have SRM firing, and hiding the second behind the first would invite shipping
 * a result whose assignment is broken. One whose Analysis result is absent lands
 * in neither list and in `noData`, so it is never counted as clear.
 */
export function classifyOverviewExperiments(
  readings: readonly OverviewExperimentReading[],
): OverviewClassification {
  const needingDecision: OverviewDecisionExperiment[] = [];
  const failing: OverviewFailingExperiment[] = [];
  const noData: OverviewExperimentRef[] = [];
  for (const reading of readings) {
    const ref = { id: reading.id, name: reading.name, runId: reading.runId };
    if (reading.state === "no_data") {
      noData.push(ref);
      continue;
    }
    const decision = decisionReasons(reading);
    if (decision.length > 0) needingDecision.push({ ...ref, reasons: asNonEmpty(decision) });
    const failure = failureReasons(reading.stats);
    if (failure.length > 0) failing.push({ ...ref, reasons: asNonEmpty(failure) });
  }
  return { needingDecision, failing, noData };
}

/**
 * Significance is read off the same locked decision family the ship gate reads
 * (ADR-0030), so the Overview cannot say "ready" while the gate refuses, or the
 * reverse.
 */
function decisionReasons(reading: OverviewExperimentRead): OverviewDecisionReason[] {
  const reasons: OverviewDecisionReason[] = [];
  if (lockedFamilyMembers(reading.stats).some((member) => member.result.is_significant)) {
    reasons.push("significance_reached");
  }
  if (horizonReached(reading)) reasons.push("horizon_reached");
  return reasons;
}

/**
 * Only a fixed-horizon Run has a horizon to reach; a sequential Run is decided by
 * significance alone. `deduped_counts` is the enrolled-entity count the sample
 * size was locked against, and it already excludes the multiple-assignment
 * bucket, so this compares like with like.
 */
function horizonReached(reading: OverviewExperimentRead): boolean {
  if (reading.horizon !== "fixed" || reading.sampleSizeLocked === null) return false;
  const enrolled = Object.values(reading.stats.health.deduped_counts).reduce(
    (total, count) => total + count,
    0,
  );
  return enrolled >= reading.sampleSizeLocked;
}

function failureReasons(stats: StatsOutput): OverviewFailureReason[] {
  const reasons: OverviewFailureReason[] = [];
  if (srmFiring(stats)) reasons.push("srm_firing");
  if (guardrailBreached(stats)) reasons.push("guardrail_breached");
  if (stats.health.multiple_rate >= MULTIPLE_ASSIGNMENT_RATE_THRESHOLD) {
    reasons.push("multiple_assignment_quarantine");
  }
  return reasons;
}

function asNonEmpty<T>(values: T[]): [T, ...T[]] {
  const [first, ...rest] = values;
  if (first === undefined) throw new Error("overview attention reason list is empty");
  return [first, ...rest];
}
