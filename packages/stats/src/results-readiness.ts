import { type DecisionGateCheck, statisticalGateCheckIds } from "@splitch/contracts";

const STATISTICAL_CHECK_IDS: ReadonlySet<string> = new Set(statisticalGateCheckIds);

export function statisticalReadiness(checks: readonly DecisionGateCheck[]): boolean {
  return !checks.some((check) => check.status === "fail" && STATISTICAL_CHECK_IDS.has(check.id));
}

export function reasonsFromChecks(checks: readonly DecisionGateCheck[]): string[] {
  return checks.filter((check) => check.status === "fail").map((check) => check.detail);
}
