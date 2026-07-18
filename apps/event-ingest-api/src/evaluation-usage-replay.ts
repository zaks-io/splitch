import type { EvaluationUsageReplayWindow } from "./evaluation-usage-replay-window";
import type { EvaluationUsageScope } from "./types";

/**
 * Caller idempotency is bounded from first receipt and scoped by Evaluation
 * source so cached telemetry cannot preclaim a billable remote Evaluation.
 */
export async function claimEvaluationUsageEventId(
  scope: EvaluationUsageScope,
  idempotencyKey: string,
  replayWindow: EvaluationUsageReplayWindow,
  source: "cached" | "remote",
): Promise<string> {
  const material = [
    scope.organizationId,
    scope.appId,
    scope.environmentId,
    source,
    idempotencyKey,
  ].join("\u001f");
  return replayWindow.claim(await sha256Hex(material));
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
