import {
  DEFAULT_PLANNED_DURATION_DAYS,
  DEFAULT_SEQUENTIAL_TARGET_N,
  MAX_PLANNED_DURATION_DAYS,
  PLANNED_DURATION_WEEK_DAYS,
  type TargetNSource,
} from "@splitch/contracts";

/**
 * The Run commitments a Start resolves from caller intent (ADR-0059): the
 * sequential tuning target and the planned duration. Both Start doors and the
 * Approval replay call this one resolver, so an omitted field freezes the same
 * default, recorded as defaulted, whichever door opened the Run.
 */
export interface ResolvedRunCommitments {
  targetN: number | null;
  targetNSource: TargetNSource | null;
  plannedDurationDays: number;
  plannedDurationOverrideReason: string | null;
}

export interface CommitmentIntent {
  targetN?: unknown;
  plannedDurationDays?: unknown;
  plannedDurationOverrideReason?: unknown;
}

export type CommitmentIssue = { field: keyof CommitmentIntent; message: string };

export function resolveRunCommitments(
  intent: CommitmentIntent,
  horizon: "sequential" | "fixed",
): { ok: true; value: ResolvedRunCommitments } | { ok: false; issue: CommitmentIssue } {
  const target = resolveTargetN(intent.targetN, horizon);
  if (!target.ok) return target;
  const duration = resolvePlannedDuration(
    intent.plannedDurationDays,
    intent.plannedDurationOverrideReason,
  );
  if (!duration.ok) return duration;
  return { ok: true, value: { ...target.value, ...duration.value } };
}

function resolveTargetN(raw: unknown, horizon: "sequential" | "fixed") {
  if (raw === undefined || raw === null) {
    // A fixed-horizon Run is decided at its locked sample size and the engine
    // refuses a target_n on it, so there is nothing to default.
    return horizon === "fixed"
      ? ok({ targetN: null, targetNSource: null })
      : ok({ targetN: DEFAULT_SEQUENTIAL_TARGET_N, targetNSource: "default" as const });
  }
  if (!isPositiveInteger(raw)) return issue("targetN", "targetN must be a positive integer");
  if (horizon === "fixed") {
    return issue(
      "targetN",
      "targetN tunes the sequential confidence sequence; a fixed-horizon Run decides at sampleSizeLocked instead",
    );
  }
  return ok({ targetN: raw, targetNSource: "caller" as const });
}

function resolveOverrideReason(raw: unknown) {
  if (raw === undefined || raw === null) return ok(null);
  if (typeof raw !== "string" || raw.trim() === "") {
    return issue("plannedDurationOverrideReason", "plannedDurationOverrideReason must be text");
  }
  return ok(raw);
}

function resolvePlannedDuration(rawDays: unknown, rawReason: unknown) {
  const overrideReason = resolveOverrideReason(rawReason);
  if (!overrideReason.ok) return overrideReason;
  const reason = overrideReason.value;
  const days = rawDays === undefined || rawDays === null ? DEFAULT_PLANNED_DURATION_DAYS : rawDays;
  if (!isPositiveInteger(days) || days > MAX_PLANNED_DURATION_DAYS) {
    return issue(
      "plannedDurationDays",
      `plannedDurationDays must be a whole number of days from 1 to ${MAX_PLANNED_DURATION_DAYS}`,
    );
  }
  const wholeWeeks = days % PLANNED_DURATION_WEEK_DAYS === 0;
  if (!wholeWeeks && reason === null) {
    return issue(
      "plannedDurationDays",
      `a planned duration that is not whole weeks departs from the ${DEFAULT_PLANNED_DURATION_DAYS}-day weekly-cycle policy, so it needs plannedDurationOverrideReason`,
    );
  }
  // A reason on a policy-compliant duration would be recorded as an override
  // that overrides nothing.
  if (wholeWeeks && reason !== null) {
    return issue(
      "plannedDurationOverrideReason",
      "plannedDurationOverrideReason labels a duration that is not whole weeks; this duration needs no override",
    );
  }
  return ok({ plannedDurationDays: days, plannedDurationOverrideReason: reason });
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function ok<T>(value: T): { ok: true; value: T } {
  return { ok: true, value };
}

function issue(field: CommitmentIssue["field"], message: string) {
  return { ok: false as const, issue: { field, message } };
}
