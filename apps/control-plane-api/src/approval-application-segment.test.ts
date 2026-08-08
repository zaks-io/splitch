import type { ApprovalRequest } from "@splitch/contracts";
import type { ApprovalCommit, Repository } from "@splitch/db";
import { describe, expect, it } from "vitest";
import { makeOtherApprovalApplication } from "./approval-application";

describe("Segment Approval application errors", () => {
  it("names the missing Segment held by the Approval Request", async () => {
    const apply = makeOtherApprovalApplication({
      repo: {
        flags: { getSegment: async () => null },
      } as unknown as Repository,
    });

    const result = await apply(
      {
        appId: "app_a",
        operation: "segments_update",
        target: { type: "segment", id: "segment_missing" },
      } as unknown as ApprovalRequest,
      {} as ApprovalCommit,
    );

    expect(result).toEqual({
      ok: false,
      // The Segment was never found, so there was nothing to write and nothing
      // for the operator to clean up.
      targetState: "rolled_back",
      error: {
        code: "SEGMENT_NOT_FOUND",
        details: { missingSegmentIds: ["segment_missing"] },
      },
    });
  });
});
