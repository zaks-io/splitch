import { describe, expect, it } from "vitest";
import { setProdPolicy } from "../src/config-store-harness-core";
import {
  h,
  ids,
  kvFlag,
  replaceRules,
  request,
  seedSegment,
  segmentRequest,
  segmentRule,
  useTargetingRuleSegmentsHarness,
} from "./targeting-rule-segments-harness";

useTargetingRuleSegmentsHarness();

describe("Targeting Rule Segment Approval", () => {
  it("republishes every dependent Environment when Segment Conditions change", async () => {
    await seedSegment("segment_paid", "paid");
    expect(
      (await replaceRules(ids.environmentId, segmentRule("segment_paid"), "prod")).status,
    ).toBe(200);
    expect(
      (
        await replaceRules(
          ids.devEnvironmentId,
          segmentRule("segment_paid", "rule_segment_paid_dev"),
          "dev",
        )
      ).status,
    ).toBe(200);
    h.nudges.length = 0;

    const response = await segmentRequest("PATCH", "segment_paid", {
      conditions: [{ attribute: "plan", operator: "eq", value: "enterprise" }],
    });

    expect(response.status).toBe(200);
    expect((await kvFlag(ids.environmentId)).targetingRules[0]?.conditions).toEqual([
      { attribute: "plan", operator: "eq", value: "enterprise" },
    ]);
    expect((await kvFlag(ids.devEnvironmentId)).targetingRules[0]?.conditions).toEqual([
      { attribute: "plan", operator: "eq", value: "enterprise" },
    ]);
    expect(h.nudges).toHaveLength(2);
    expect(h.nudges.every((nudge) => nudge.entity === "flag" && nudge.id === ids.flagId)).toBe(
      true,
    );
    const listed = await request("GET", `/apps/${ids.appId}/segments`);
    expect(await listed.json()).toMatchObject({
      affectedEnvironmentIds: {
        segment_paid: [ids.devEnvironmentId, ids.environmentId],
      },
    });
    expect(await h.d1.prepare("SELECT COUNT(*) AS n FROM approval_requests").first()).toMatchObject(
      {
        n: 0,
      },
    );
  });

  it("requires Approval before publishing a gated Segment Conditions change", async () => {
    await seedSegment("segment_paid", "paid");
    expect(
      (await replaceRules(ids.environmentId, segmentRule("segment_paid"), "gated_setup")).status,
    ).toBe(200);
    await setProdPolicy(h, {
      variantAvailability: "allow",
      targetingRolloutValue: "confirm",
      enabledState: "allow",
      startExperimentRun: "allow",
    });
    h.nudges.length = 0;
    const patch = {
      conditions: [{ attribute: "plan", operator: "eq", value: "enterprise" }],
      idempotency_key: "segment_conditions_confirm",
    };

    const proposed = await segmentRequest("PATCH", "segment_paid", patch);
    expect(proposed.status).toBe(409);
    expect(await proposed.json()).toMatchObject({
      code: "APPROVAL_REVIEW_REQUIRED",
      details: {
        policyContexts: [
          {
            environmentId: ids.environmentId,
            changeTypes: ["targeting_rollout_value"],
            level: "confirm",
          },
        ],
      },
    });
    expect((await kvFlag(ids.environmentId)).targetingRules[0]?.conditions).toEqual([
      { attribute: "plan", operator: "eq", value: "paid" },
    ]);
    expect(h.nudges).toEqual([]);

    const approved = await segmentRequest("PATCH", "segment_paid", {
      ...patch,
      review: { action: "approve_and_apply" },
    });
    expect(approved.status).toBe(200);
    expect((await kvFlag(ids.environmentId)).targetingRules[0]?.conditions).toEqual([
      { attribute: "plan", operator: "eq", value: "enterprise" },
    ]);
    expect(h.nudges).toHaveLength(1);
  });
});
