import { describe, expect, it } from "vitest";
import { mapApprovedFlagConfigFailure } from "./approval-review-application";

/**
 * SPL-304. Deleting the terminal CHANGED_FIELDS_UNDETERMINED branch would fall
 * through to a retryable INTERNAL_SERVER_ERROR with empty details — pin that
 * the outcome stays `unapplicable` with a named fault.
 */
describe("mapApprovedFlagConfigFailure", () => {
  it("resolves CHANGED_FIELDS_UNDETERMINED terminally with a named fault", () => {
    expect(
      mapApprovedFlagConfigFailure(
        { ok: false, reason: "CHANGED_FIELDS_UNDETERMINED" },
        "flag_1",
        "env_1",
      ),
    ).toEqual({
      ok: false,
      unapplicable: {
        code: "INTERNAL_SERVER_ERROR",
        message:
          "Approval Request changed-field set could not be determined; refuse rather than apply",
        details: { fault: "approval_changed_fields_undetermined" },
      },
    });
  });

  it("still maps RUN_FROZEN to unapplicable", () => {
    const outcome = mapApprovedFlagConfigFailure(
      {
        ok: false,
        reason: "RUN_FROZEN",
        frozenFields: ["flagConfig.rollout"],
        currentRunId: "run_live",
        attemptedChange: "APPLY_APPROVED_FLAG_CONFIG",
      },
      "flag_1",
      "env_1",
    );
    expect(outcome).toMatchObject({
      ok: false,
      unapplicable: { code: "RUN_FROZEN" },
    });
  });
});
