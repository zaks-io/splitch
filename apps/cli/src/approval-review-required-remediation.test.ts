import { describe, expect, it } from "vitest";
import { remediationForServerError } from "./approval-stale-warn.js";

const approvalRequestId = "apr_01J00000000000000000000000";

describe("remediationForServerError APPROVAL_REVIEW_REQUIRED", () => {
  it("names the Approval Request and --confirm when the command supports it", () => {
    const line = remediationForServerError(
      {
        code: "APPROVAL_REVIEW_REQUIRED",
        message: "review required before this change can apply",
        details: {
          approvalRequestId,
          status: "pending",
          policyContexts: [
            { environmentId: "env_prod", changeTypes: ["enabled_state"], level: "confirm" },
          ],
          recommendedAction: "REVIEW_APPROVAL_REQUEST",
        },
      },
      true,
    );
    expect(line).toContain(approvalRequestId);
    expect(line).toContain("--confirm");
    expect(line.toLowerCase()).not.toContain(
      "correct the reported api failure and retry the command",
    );
  });

  it("still gives the --confirm hint without a request id, when the command supports it", () => {
    // A malformed response could omit the id; the contract requires it, so cast
    // past the type to exercise the defensive branch.
    const line = remediationForServerError(
      {
        code: "APPROVAL_REVIEW_REQUIRED",
        message: "review required before this change can apply",
        details: {
          status: "pending",
          policyContexts: [
            { environmentId: "env_prod", changeTypes: ["enabled_state"], level: "confirm" },
          ],
          recommendedAction: "REVIEW_APPROVAL_REQUEST",
        },
      } as unknown as Parameters<typeof remediationForServerError>[0],
      true,
    );
    expect(line).toContain("--confirm");
    expect(line.toLowerCase()).not.toContain(
      "correct the reported api failure and retry the command",
    );
  });

  it("names the Approval Request but omits --confirm when the command does not support it", () => {
    // Models flags_delete: APPROVAL_REVIEW_REQUIRED is possible, but the DELETE
    // route has no body, so --confirm can never be honored (SPL-378 follow-up).
    const line = remediationForServerError(
      {
        code: "APPROVAL_REVIEW_REQUIRED",
        message: "review required before this change can apply",
        details: {
          approvalRequestId,
          status: "pending",
          policyContexts: [
            { environmentId: "env_prod", changeTypes: ["enabled_state"], level: "confirm" },
          ],
          recommendedAction: "REVIEW_APPROVAL_REQUEST",
        },
      },
      false,
    );
    expect(line).toContain(approvalRequestId);
    expect(line).toContain(`splitch approval-requests get ${approvalRequestId}`);
    expect(line).not.toContain("--confirm");
    expect(line.toLowerCase()).not.toContain(
      "correct the reported api failure and retry the command",
    );
  });
});
