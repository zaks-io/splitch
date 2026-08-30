import { describe, expect, it } from "vitest";
import { flagWriteDecision } from "#lib/flags/flag-write-decision";

describe("Flag write decision", () => {
  it("reports an ungated apply as applied with no Approval Request", () => {
    expect(flagWriteDecision({ ok: true, status: 200, approvalRequest: null })).toEqual({
      kind: "applied",
      approvalRequest: null,
    });
  });

  /**
   * The gated refusal is the ONLY path to the confirm gate. Treating it as a plain
   * error would strand the operator on a 409 while the proposal they just made sits
   * pending in the audit log.
   */
  it("turns the Policy-gated refusal into a gate carrying the recorded request id", () => {
    const decision = flagWriteDecision({
      ok: false,
      status: 409,
      error: {
        code: "APPROVAL_REVIEW_REQUIRED",
        message: "Approval Request is pending Review",
        details: {
          approvalRequestId: "apr_1",
          status: "pending",
          policyContexts: [
            { environmentId: "env_prod", changeTypes: ["enabled_state"], level: "confirm" },
          ],
          recommendedAction: "REVIEW_APPROVAL_REQUEST",
        },
      },
    });

    expect(decision).toEqual({ kind: "gate", approvalRequestId: "apr_1" });
  });

  it("keeps a structural refusal structural instead of flattening it to a message", () => {
    const decision = flagWriteDecision({
      ok: false,
      status: 422,
      error: {
        code: "VARIANT_NOT_AVAILABLE",
        message: "Variant is not available in this Environment",
        details: {
          flagId: "flag_1",
          environmentId: "env_prod",
          missingVariants: ["treatment"],
          recommendedAction: "ADD_VARIANT_TO_ENV",
        },
      },
    });

    expect(decision.kind).toBe("refused");
    expect(decision.kind === "refused" && decision.error.code).toBe("VARIANT_NOT_AVAILABLE");
  });
});
