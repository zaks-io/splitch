import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startSeededExperiment } from "../src/config-store-fixture-data";
import { type Harness, setProdPolicy } from "../src/config-store-harness-core";
import {
  confirmPolicy,
  patchConfig,
  patchVariant,
  readRequest,
  reviewRequest,
} from "./approval-harness";
import { makePoolHarness } from "./config-store-pool-harness";

/**
 * ONE trigger, ONE Request status (SPL-267, round 5).
 *
 * A proposal minted before Start and reviewed after it is refused by the same
 * live Run whichever door the write came through. The Flag Configuration path
 * always resolved that Request terminally; the Variant path this PR added parked
 * it as `pending` behind `RETRY_REVIEW` — a remedy that cannot succeed while the
 * Run lives, which is the impossible remedy ADR-0036 forbids and the exact defect
 * class this ticket exists to close.
 *
 * The equivalence is the invariant, so it is asserted as one rather than as two
 * independently pinned constants: a future change that moves one path's outcome
 * without the other fails here even if both remain individually defensible.
 */

let h: Harness;

beforeEach(async () => {
  h = await makePoolHarness();
  await setProdPolicy(h, confirmPolicy);
});

afterEach(async () => {
  await h.dispose();
});

interface Resolution {
  reviewStatus: number;
  reviewCode: string | undefined;
  requestStatus: unknown;
}

/** Approve a pending Request and read where it landed. */
async function resolutionOf(requestId: string, key: string): Promise<Resolution> {
  const review = await reviewRequest(h, requestId, key);
  const body = (await review.json()) as { code?: string };
  const stored = await readRequest(h, requestId);
  return {
    reviewStatus: review.status,
    reviewCode: body.code,
    requestStatus: (stored.body as { status?: unknown }).status,
  };
}

describe("a Run starting under two pending proposals resolves both the same way", () => {
  it("refuses the Variant write exactly as it refuses the Flag Configuration write", async () => {
    const config = await patchConfig(h, "spl267_parity_config", {
      availableVariantNames: ["control"],
    });
    const variant = await patchVariant(h, "treatment", "spl267_parity_variant", {
      value: "PWNED_MID_REVIEW",
    });
    expect(config.code).toBe("APPROVAL_REVIEW_REQUIRED");
    expect(variant.code).toBe("APPROVAL_REVIEW_REQUIRED");

    // Both Requests are pending when the SAME Run starts, so the only difference
    // between them is which mutation they carry.
    await startSeededExperiment(h.d1);
    const configResolution = await resolutionOf(
      config.approvalRequestId as string,
      "spl267_parity_config_r",
    );
    const variantResolution = await resolutionOf(
      variant.approvalRequestId as string,
      "spl267_parity_variant_r",
    );

    console.log("PARITY flag-config:", JSON.stringify(configResolution));
    console.log("PARITY variant    :", JSON.stringify(variantResolution));

    expect(variantResolution).toEqual(configResolution);
    expect(variantResolution.reviewCode).toBe("RUN_FROZEN");
    // A parked Request hands the caller RETRY_REVIEW on a refusal that cannot
    // succeed while the Run lives.
    expect(variantResolution.requestStatus).not.toBe("pending");
  });
});
