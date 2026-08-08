import { appScope } from "@splitch/db";
import { describe, expect, it } from "vitest";
import {
  h,
  ids,
  NOW,
  replaceRules,
  segmentRule,
  useTargetingRuleSegmentsHarness,
} from "./targeting-rule-segments-harness";

useTargetingRuleSegmentsHarness();

describe("Targeting Rule Segment App scope", () => {
  it.each([
    ["missing", "segment_missing"],
    ["cross-App", "segment_other_app"],
  ])("rejects a %s Segment", async (_, segmentId) => {
    if (segmentId === "segment_other_app") {
      await h.repo.flags.segments.insert(appScope(ids.otherAppId), {
        id: segmentId,
        appId: ids.otherAppId,
        name: "Other App Segment",
        conditions: "[]",
        createdAt: NOW,
        updatedAt: NOW,
      });
    }

    const response = await replaceRules(ids.environmentId, segmentRule(segmentId), "invalid");

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      code: "SEGMENT_NOT_FOUND",
      details: { missingSegmentIds: [segmentId] },
    });
  });
});
