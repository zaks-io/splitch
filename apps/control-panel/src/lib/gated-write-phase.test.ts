import { describe, expect, it } from "vitest";
import type { ApprovalGateRecord } from "./approval-gate-record";
import { gatedWritePhase } from "./gated-write-phase";

const summary = "Turn New Checkout on";

describe("Gated write phase", () => {
  it("opens the confirm gate on the Approval Request the Worker recorded", () => {
    const phase = gatedWritePhase(summary, {
      ok: true,
      status: 200,
      data: gateRecord(),
    });

    expect(phase.phase).toBe("gate");
    expect(phase.phase === "gate" && phase.request.id).toBe("apr_1");
    // The gate opens un-confirmed and un-errored, so the operator's first click is
    // the confirmation and not a retry of somebody else's failure.
    expect(phase.phase === "gate" && phase.confirming).toBe(false);
    expect(phase.phase === "gate" && phase.error).toBeNull();
  });

  /**
   * The mutant this kills: returning to `idle` when the Approval Request read
   * fails. The Worker has ALREADY recorded a pending request at this point. An
   * idle-looking form tells the operator nothing happened, they retry, and a
   * second pending Approval Request accumulates in the audit log unseen — a
   * silent failure wearing the costume of a successful no-op (ADR-0036).
   */
  it("refuses loudly when the recorded Approval Request cannot be read back", () => {
    const phase = gatedWritePhase(summary, {
      ok: false,
      status: 500,
      error: {
        code: "INTERNAL_SERVER_ERROR",
        message: "approvals read failed",
        details: {},
      },
    });

    expect(phase.phase).toBe("refused");
    expect(phase.phase === "refused" && phase.error.code).toBe("INTERNAL_SERVER_ERROR");
    // The summary survives the refusal: the notice names the change that was
    // proposed, not an anonymous failure detached from what the operator did.
    expect(phase.phase === "refused" && phase.error.message).toBe("approvals read failed");
  });

  it("keeps an unauthorized read a refusal rather than a dismissible blank state", () => {
    const phase = gatedWritePhase(summary, {
      ok: false,
      status: 401,
      error: { code: "UNAUTHORIZED", message: "session expired", details: {} },
    });

    expect(phase).toMatchObject({ phase: "refused", summary });
  });
});

function gateRecord(): ApprovalGateRecord {
  return {
    id: "apr_1",
    status: "pending",
    operation: "flag_config_update",
    targetType: "flag_configuration",
    proposerUserId: "user_1",
    proposedAt: "2026-07-18T00:00:00.000Z",
    policyContexts: [
      { environmentId: "env_prod", changeTypes: ["enabled_state"], level: "confirm" },
    ],
    rows: [],
  };
}
