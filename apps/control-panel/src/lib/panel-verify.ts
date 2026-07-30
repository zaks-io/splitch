import type { ResolutionDetails, ResolutionReason } from "@splitch/contracts";
import { createSplitchClient } from "@splitch/sdk";

/**
 * The Panel's "Test this Flag" seam.
 *
 * This runs in the Panel Worker, not the browser, and it deliberately mirrors
 * `apps/cli/src/execute-operations.ts` (`splitch flags verify`): read the
 * Environment's Client Key, hand it to the shipped `@splitch/sdk`, call
 * `verify`. Same credential, same transport, same result — so the panel button
 * and the CLI command cannot drift into two different answers.
 *
 * Server-side rather than browser-side because a Client Key may be locked to the
 * customer's own origins (ADR-0034). A browser call from the panel origin would
 * then fail `ORIGIN_NOT_ALLOWED` and read as "your Flag is broken" when nothing
 * is broken.
 *
 * `verify` fires no Exposure by construction (ADR-0004/0026); the invariant is
 * proven at the real boundary in `apps/evaluation-api/src/verify.test.ts`.
 */
export interface PanelVerifyInput {
  readonly clientKey: string;
  readonly endpoint: string;
  readonly flagKey: string;
  readonly targetingKey: string;
  readonly fetch?: typeof fetch;
}

/**
 * The wire shape the browser receives. Only primitives cross the boundary (the
 * same rule the Flag detail server fn follows): a Variant value may be a JSON
 * object, and the panel renders it as text either way.
 */
export interface PanelVerifyOutcome {
  readonly reason: ResolutionReason;
  readonly variantName: string | null;
  readonly valueJson: string;
  readonly ruleId: string | null;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
}

export function panelVerifyOutcome(details: ResolutionDetails): PanelVerifyOutcome {
  return {
    reason: details.reason,
    variantName: details.variantName,
    valueJson: JSON.stringify(details.value),
    ruleId: details.ruleId ?? null,
    errorCode: details.errorCode ?? null,
    errorMessage: details.errorMessage ?? null,
  };
}

export async function verifyFlagWithClientKey(input: PanelVerifyInput): Promise<ResolutionDetails> {
  const client = createSplitchClient({
    clientKey: input.clientKey,
    endpoint: input.endpoint,
    ...(input.fetch ? { fetch: input.fetch } : {}),
  });
  return client.verify(input.flagKey, { targetingKey: input.targetingKey });
}

/**
 * Plain-language rendering of a verify result.
 *
 * `tone` is the fail-loud discriminator the UI keys off: an ERROR must never be
 * able to render in the same shape as a resolution (ADR-0036). There is no
 * "unknown" fallthrough — every reason in the contract has a sentence.
 */
export interface VerifyExplanation {
  readonly tone: "resolved" | "failed";
  readonly headline: string;
  readonly detail: string;
}

export function explainVerifyResult(outcome: PanelVerifyOutcome): VerifyExplanation {
  if (outcome.reason === "ERROR") {
    return {
      tone: "failed",
      headline: "Verify failed",
      detail: `${outcome.errorCode ?? "UNKNOWN"}: ${
        outcome.errorMessage ?? "The Evaluation API did not return a resolution."
      } No Variant was resolved, so no value is shown: the SDK would hand your code its Default Variant fallback, which is not an answer from your Flag.`,
    };
  }

  return {
    tone: "resolved",
    headline: `Resolved to ${outcome.variantName ?? "the Default Variant"}`,
    detail: reasonSentence(outcome),
  };
}

function reasonSentence(outcome: PanelVerifyOutcome): string {
  switch (outcome.reason) {
    case "SPLIT":
      return "This targeting key falls in that Variant's slice of the split.";
    case "TARGETING_MATCH":
      return `A targeting rule matched this key${outcome.ruleId ? ` (rule ${outcome.ruleId})` : ""}.`;
    case "DEFAULT":
      return "No targeting rule matched, so the Flag's Default Variant was returned.";
    case "DISABLED":
      return "The Flag is disabled in this Environment, so every key gets the Default Variant.";
    case "CACHED":
      return "Served from a cached resolution for this key.";
    case "STALE":
      return "Served from a stale cached resolution because fresh config was unavailable.";
    case "ERROR":
      return "The Evaluation API returned an error.";
  }
}

/** Verify is a wiring check. It is explicitly NOT the onboarding finish line. */
export const VERIFY_IS_NOT_AN_EXPOSURE =
  "This test resolves your Flag without recording an Exposure, so it cannot skew an Experiment. Onboarding is done when your own code calls evaluate() for the first time.";
