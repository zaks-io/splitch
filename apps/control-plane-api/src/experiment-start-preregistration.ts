import { type PreRegistration, resolvePreRegistration } from "@splitch/contracts";
import { validationErrors } from "./flag-definition-errors";

/**
 * Resolve optional Start pre-registration against the Metric ids the Run will
 * freeze. Omitted intent returns null (no behavior change for existing clients).
 */

export function resolveStartPreRegistration(
  raw: unknown,
  runMetricIds: ReadonlySet<string>,
  requestId: string,
): { ok: true; value: PreRegistration | null } | { ok: false; response: Response } {
  if (raw === undefined) return { ok: true, value: null };
  const resolved = resolvePreRegistration(raw, runMetricIds);
  if (!resolved.ok) {
    return { ok: false, response: validationErrors(requestId, resolved.issues) };
  }
  return { ok: true, value: resolved.value };
}

export function runMetricIdsFromPrepared(prepared: {
  decisionFamily: ReadonlyArray<{ metricId: string }>;
  guardrailDecisions: ReadonlyArray<{ metric_id: string }>;
}): Set<string> {
  return new Set([
    ...prepared.decisionFamily.map((metric) => metric.metricId),
    ...prepared.guardrailDecisions.map((metric) => metric.metric_id),
  ]);
}
