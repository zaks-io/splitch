/**
 * A refused write has to say what is MISSING, not that something was wrong. The
 * Control Plane already answers with per-field issues (an empty goal Metric
 * family, an allocation that does not total 100, a fixed horizon with no sample
 * size), so the operator is shown those rather than the generic envelope
 * message, which would name a problem with no remedy attached (ADR-0036).
 */
export function controlPlaneErrorMessage(error: {
  message: string;
  details?: Record<string, unknown>;
}): string {
  const issues = error.details?.issues;
  if (!Array.isArray(issues)) return error.message;
  const messages = issues
    .map((issue) => (issue as { message?: unknown } | null)?.message)
    .filter((message): message is string => typeof message === "string");
  return messages.length > 0 ? messages.join(" ") : error.message;
}
