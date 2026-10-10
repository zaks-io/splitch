import type { DecisionGateCheck } from "@splitch/contracts";
import { MAX_PLANNED_DURATION_DAYS } from "@splitch/contracts";

/**
 * The planned-duration readiness check (ADR-0059, plan decision D7).
 *
 * The observation window is measured from the Run's start to the selected
 * evidence's watermark, never to the wall clock. A Conclude on day seven that
 * selects a day-one watermark is deciding on one day of evidence, so it has to
 * be refused exactly as a day-one Conclude would be.
 */
export interface PlannedDurationEvidence {
  /** Null when the Run started before planned durations were recorded. */
  plannedDurationDays: number | null;
  overrideReason: string | null;
  runStartedAt: string;
  /** The selected evidence's watermark; null when Analysis reported none. */
  dataWatermark: string | null;
}

const DAY_MS = 86_400_000;

export function observedEvidenceDays(runStartedAt: string, dataWatermark: string): number {
  const started = Date.parse(runStartedAt);
  const watermark = Date.parse(dataWatermark);
  if (!Number.isFinite(started)) throw new Error(`Run start ${runStartedAt} is not a timestamp`);
  if (!Number.isFinite(watermark)) {
    throw new Error(`evidence watermark ${dataWatermark} is not a timestamp`);
  }
  return Math.max(0, watermark - started) / DAY_MS;
}

export function earliestDecisionWatermark(runStartedAt: string, plannedDurationDays: number) {
  return new Date(Date.parse(runStartedAt) + plannedDurationDays * DAY_MS).toISOString();
}

export function plannedDurationCheck(evidence: PlannedDurationEvidence): DecisionGateCheck {
  const planned = evidence.plannedDurationDays;
  if (
    planned !== null &&
    !(Number.isInteger(planned) && planned > 0 && planned <= MAX_PLANNED_DURATION_DAYS)
  ) {
    throw new Error(
      `planned duration ${String(planned)} is not a whole number of days from 1 to ${MAX_PLANNED_DURATION_DAYS}`,
    );
  }
  if (planned === null) {
    return {
      id: "planned_duration",
      status: "not_applicable",
      title: "No planned duration recorded",
      detail:
        "This Run started before planned durations were recorded at Start, so there is no duration commitment to measure. None is invented for it.",
    };
  }
  const override = evidence.overrideReason
    ? ` The ${planned}-day plan is a labeled override: ${evidence.overrideReason}`
    : "";
  if (evidence.dataWatermark === null) {
    return {
      id: "planned_duration",
      status: "fail",
      title: "No evidence watermark to measure duration against",
      detail: `The planned duration is ${dayCount(planned)}, measured from Run start to the evidence watermark. Analysis reported no watermark, so the observed window is unknown.${override}`,
    };
  }
  const observed = observedEvidenceDays(evidence.runStartedAt, evidence.dataWatermark);
  if (observed < planned) {
    return {
      id: "planned_duration",
      status: "fail",
      title: "Run has not reached its planned duration",
      detail: `The selected evidence covers ${formatDays(observed)} of the ${dayCount(planned)} this Run planned at Start. Select evidence with a watermark at or after ${earliestDecisionWatermark(evidence.runStartedAt, planned)}.${override}`,
    };
  }
  return {
    id: "planned_duration",
    status: "pass",
    title: "Planned duration reached",
    detail: `The selected evidence covers ${formatDays(observed)}, at least the ${dayCount(planned)} this Run planned at Start.${override}`,
  };
}

function dayCount(days: number): string {
  return `${days} ${days === 1 ? "day" : "days"}`;
}

function formatDays(days: number): string {
  const rounded = Math.floor(days * 10) / 10;
  return `${rounded} ${rounded === 1 ? "day" : "days"}`;
}
