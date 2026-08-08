import { describe, expect, it } from "vitest";
import { appScope, envScope } from "@splitch/db";
import { setProdPolicy, startSeededExperiment } from "../src/config-store-harness-core";
import { reviewRequest } from "./approval-harness";
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

  it("records failed republication and applies the same Approval after the Run ends", async () => {
    await seedSegment("segment_paid", "paid");
    expect(
      (await replaceRules(ids.environmentId, segmentRule("segment_paid"), "retry_setup")).status,
    ).toBe(200);
    await setProdPolicy(h, {
      variantAvailability: "allow",
      targetingRolloutValue: "confirm",
      enabledState: "allow",
      startExperimentRun: "allow",
    });
    await startSeededExperiment(h.d1);

    const proposed = await segmentRequest("PATCH", "segment_paid", {
      conditions: [{ attribute: "plan", operator: "eq", value: "enterprise" }],
      idempotency_key: "segment_conditions_retry",
    });
    expect(proposed.status).toBe(409);
    const proposal = (await proposed.json()) as { details: { approvalRequestId: string } };

    const failed = await reviewRequest(
      h,
      proposal.details.approvalRequestId,
      "segment_review_frozen",
    );
    expect(failed.status).toBe(409);
    expect(await failed.json()).toMatchObject({
      code: "APPROVAL_APPLICATION_FAILED",
      details: {
        applicationError: {
          code: "RUN_FROZEN",
          details: {
            currentRunId: ids.liveRunId,
            notRepublishedFlagConfigurations: [
              expect.objectContaining({
                flagConfigurationId: ids.configId,
                flagId: ids.flagId,
                environmentId: ids.environmentId,
                reason: "RUN_FROZEN",
                currentRunId: ids.liveRunId,
              }),
            ],
          },
        },
      },
    });
    expect(
      await h.repo.approvals.getRequest(appScope(ids.appId), proposal.details.approvalRequestId),
    ).toMatchObject({ status: "pending", resolvedAt: null });
    expect(
      await h.d1
        .prepare(
          "SELECT outcome, error_code FROM approval_reviews WHERE app_id = ? AND approval_request_id = ?",
        )
        .bind(ids.appId, proposal.details.approvalRequestId)
        .first(),
    ).toMatchObject({ outcome: "failed", error_code: "RUN_FROZEN" });
    expect((await kvFlag(ids.environmentId)).targetingRules[0]?.conditions).toEqual([
      { attribute: "plan", operator: "eq", value: "paid" },
    ]);

    await h.repo.experiments.updateExperiment(
      envScope(ids.appId, ids.environmentId),
      ids.experimentId,
      { status: "ended", liveRunId: null, updatedAt: "2026-07-01T21:00:00.000Z" },
      ids.liveRunId,
    );
    const retried = await reviewRequest(
      h,
      proposal.details.approvalRequestId,
      "segment_review_retry",
    );
    const retryBody = await retried.json();
    expect({ status: retried.status, body: retryBody }).toMatchObject({
      status: 200,
      body: {
        id: proposal.details.approvalRequestId,
        status: "applied",
        latestReview: { outcome: "applied" },
      },
    });
    expect((await kvFlag(ids.environmentId)).targetingRules[0]?.conditions).toEqual([
      { attribute: "plan", operator: "eq", value: "enterprise" },
    ]);
  });

  it("does not treat an ordinary Segment version race as a republication retry", async () => {
    await seedSegment("segment_paid", "paid");
    expect(
      (await replaceRules(ids.environmentId, segmentRule("segment_paid"), "stale_setup")).status,
    ).toBe(200);
    await setProdPolicy(h, {
      variantAvailability: "allow",
      targetingRolloutValue: "confirm",
      enabledState: "allow",
      startExperimentRun: "allow",
    });
    const proposed = await segmentRequest("PATCH", "segment_paid", {
      conditions: [{ attribute: "plan", operator: "eq", value: "enterprise" }],
      idempotency_key: "segment_conditions_stale",
    });
    const proposal = (await proposed.json()) as { details: { approvalRequestId: string } };
    await h.repo.flags.updateSegment(appScope(ids.appId), "segment_paid", {
      name: "Paid customers",
      updatedAt: "2026-07-01T20:30:00.000Z",
    });

    const reviewed = await reviewRequest(
      h,
      proposal.details.approvalRequestId,
      "segment_review_stale",
    );

    expect(reviewed.status).toBe(409);
    expect(await reviewed.json()).toMatchObject({
      code: "APPROVAL_REQUEST_STALE",
      details: { approvalRequestId: proposal.details.approvalRequestId },
    });
  });
});
