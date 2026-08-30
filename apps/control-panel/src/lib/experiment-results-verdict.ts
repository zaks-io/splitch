import type {
  ArmResult,
  ExperimentDecisionGate,
  ExperimentSignificanceDisplays,
  GuardrailResult,
} from "@splitch/contracts";
import { significanceKey } from "@splitch/contracts";
import { formatLift } from "../components/experiment-results-format";

export type ExperimentResultsVerdictSegment = {
  kind: "text" | "arm" | "metric" | "value";
  value: string;
};

export function experimentResultsVerdict({
  armResults,
  significance,
  guardrails,
  gate,
  baseline,
}: {
  armResults: readonly ArmResult[];
  significance: ExperimentSignificanceDisplays;
  guardrails: readonly GuardrailResult[];
  gate: ExperimentDecisionGate;
  baseline: string;
}): ExperimentResultsVerdictSegment[] {
  // The same selection as the hero tile and the station summary, so the three
  // surfaces can never name different arms on one screen.
  const leadResult = leadingSignificantResult({ armResults, significance, baseline });
  const segments: ExperimentResultsVerdictSegment[] = [];

  if (leadResult === null) {
    segments.push({ kind: "text", value: "No affirmative significance call yet. " });
  } else {
    // No Metric polarity exists in the contract, so the copy must not claim a
    // direction: a negative lift on a lower-is-better Metric is a win.
    segments.push(
      { kind: "arm", value: leadResult.variant },
      { kind: "text", value: " moves " },
      { kind: "metric", value: leadResult.metric_id },
      { kind: "text", value: " " },
      { kind: "value", value: formatLift(leadResult.relative_lift_pct) },
      { kind: "text", value: ", significant. " },
    );
  }

  segments.push(...breachSegments(guardrails), ...gateSegments(gate));
  return segments;
}

function breachSegments(guardrails: readonly GuardrailResult[]): ExperimentResultsVerdictSegment[] {
  const breached = guardrails.filter((guardrail) => guardrail.is_breached === true);
  if (breached.length === 0) return [];
  if (breached.length > 1) {
    return [
      { kind: "value", value: String(breached.length) },
      { kind: "text", value: " Guardrails are breached. " },
    ];
  }
  const [guardrail] = breached;
  if (!guardrail) throw new Error("A breached Guardrail was counted but not found");
  return [
    { kind: "metric", value: guardrail.metric_id },
    { kind: "text", value: " is breached on " },
    { kind: "arm", value: guardrail.variant },
    { kind: "text", value: ". " },
  ];
}

function gateSegments(gate: ExperimentDecisionGate): ExperimentResultsVerdictSegment[] {
  const failing = gate.checks.filter((check) => check.status === "fail");
  if (gate.shipAllowed) return [{ kind: "text", value: "No check blocks concluding." }];
  if (failing.length > 1) {
    return [
      { kind: "text", value: "The gate is blocked by " },
      { kind: "value", value: String(failing.length) },
      { kind: "text", value: " checks." },
    ];
  }
  const [check] = failing;
  if (!check) throw new Error("A blocked gate has no failing check");
  // Titles are verbatim sentences ("Sample Ratio Mismatch is firing"), so a
  // colon composes with them where "blocked by <title>." would not.
  return [{ kind: "text", value: `The gate is blocked: ${check.title}.` }];
}

export function leadingSignificantResult({
  armResults,
  significance,
  baseline,
}: {
  armResults: readonly ArmResult[];
  significance: ExperimentSignificanceDisplays;
  baseline: string;
}): ArmResult | null {
  const significant = armResults.filter(
    (result) =>
      result.variant !== baseline && significance[significanceKey(result)] === "significant",
  );
  return significant.length === 0 ? null : largestAbsoluteLift(significant);
}

export function worstGuardrailBreach(
  guardrails: readonly GuardrailResult[],
  armResults: readonly ArmResult[],
): { guardrail: GuardrailResult; armResult: ArmResult | undefined } | null {
  const first = guardrails[0];
  if (!first) return null;
  let selected = {
    guardrail: first,
    armResult: matchingGuardrailArmResult(first, armResults),
  };
  for (const guardrail of guardrails.slice(1)) {
    const candidate = {
      guardrail,
      armResult: matchingGuardrailArmResult(guardrail, armResults),
    };
    if (guardrailBreachMagnitude(candidate) > guardrailBreachMagnitude(selected)) {
      selected = candidate;
    }
  }
  return selected;
}

function matchingGuardrailArmResult(
  guardrail: GuardrailResult,
  armResults: readonly ArmResult[],
): ArmResult | undefined {
  return armResults.find(
    (result) => result.metric_id === guardrail.metric_id && result.variant === guardrail.variant,
  );
}

function guardrailBreachMagnitude(value: {
  guardrail: GuardrailResult;
  armResult: ArmResult | undefined;
}): number {
  const observed = value.armResult?.relative_lift_pct;
  return observed === null || observed === undefined
    ? Math.abs((value.guardrail.ci_lower ?? 0) - value.guardrail.threshold)
    : Math.abs(observed);
}

function largestAbsoluteLift(results: readonly ArmResult[]): ArmResult {
  const first = results[0];
  if (!first) throw new Error("A significant result was required");
  let largest = first;
  for (const result of results.slice(1)) {
    if (liftMagnitude(result) > liftMagnitude(largest)) largest = result;
  }
  return largest;
}

function liftMagnitude(result: ArmResult): number {
  return result.relative_lift_pct === null
    ? Number.NEGATIVE_INFINITY
    : Math.abs(result.relative_lift_pct);
}
