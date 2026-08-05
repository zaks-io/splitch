import { describe, expect, it, vi } from "vitest";
import { remediationForServerError, warnStaleApprovalDiscard } from "./approval-stale-warn.js";

describe("warnStaleApprovalDiscard", () => {
  it("surfaces a recorded discard cause on stderr for a stale Approval Request", () => {
    const error = vi.fn();
    warnStaleApprovalDiscard(
      { error },
      {
        id: "apr_01JTEST",
        status: "stale",
        latestReview: {
          outcome: "stale",
          error: {
            code: "RUN_FROZEN",
            details: {
              frozenFields: ["flagConfig.targetingRules"],
              currentRunId: "run_live",
              recommendedAction: "END_RUNNING_RUN_FIRST",
            },
          },
        },
      },
    );
    expect(error).toHaveBeenCalledOnce();
    expect(error.mock.calls[0]?.[0]).toContain("apr_01JTEST");
    expect(error.mock.calls[0]?.[0]).toContain("RUN_FROZEN");
    expect(error.mock.calls[0]?.[0]).toContain("flagConfig.targetingRules");
    expect(error.mock.calls[0]?.[0]).toContain("Re-propose");
  });

  it("stays quiet for a version-race stale with no recorded cause", () => {
    const error = vi.fn();
    warnStaleApprovalDiscard(
      { error },
      {
        id: "apr_01JQUIET",
        status: "stale",
        latestReview: { outcome: "stale", error: null },
      },
    );
    expect(error).not.toHaveBeenCalled();
  });

  it("scans list payloads", () => {
    const error = vi.fn();
    warnStaleApprovalDiscard(
      { error },
      {
        items: [
          {
            id: "apr_01JLIST",
            status: "stale",
            latestReview: {
              outcome: "stale",
              error: { code: "RUN_FROZEN", details: { frozenFields: ["flagConfig.rollout"] } },
            },
          },
        ],
      },
    );
    expect(error).toHaveBeenCalledOnce();
    expect(error.mock.calls[0]?.[0]).toContain("apr_01JLIST");
  });
});

describe("remediationForServerError", () => {
  it("names frozen fields on RUN_FROZEN", () => {
    expect(
      remediationForServerError({
        code: "RUN_FROZEN",
        message: "running Run run_live owns this Flag Configuration field",
        details: {
          frozenFields: ["flagConfig.availableVariantNames"],
          currentRunId: "run_live",
          attemptedChange: "APPLY_APPROVED_FLAG_CONFIG:flag_1",
          recommendedAction: "END_RUNNING_RUN_FIRST",
        },
      }),
    ).toContain("flagConfig.availableVariantNames");
  });
});
