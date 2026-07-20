/**
 * Canonical external-consumer example compiled by `test:consumer-smoke`.
 * Keep `docs/spec/quickstart.md` §8 aligned with this snippet.
 */
import { createSplitchClient, type ResolutionDetails, type VariantValue } from "@splitch/sdk";

export async function evaluateCheckout(userId: string): Promise<VariantValue> {
  const splitch = createSplitchClient({ clientKey: "ck_live_..." });

  const evaluationId = crypto.randomUUID();
  const variant = await splitch.evaluate("new-checkout", {
    targetingKey: userId,
    idempotencyKey: evaluationId,
  });

  const details: ResolutionDetails = await splitch.evaluateDetails("new-checkout", {
    targetingKey: userId,
    idempotencyKey: evaluationId,
  });
  if (details.reason === "ERROR") {
    throw new Error(details.errorCode ?? "evaluate failed");
  }

  return variant;
}
