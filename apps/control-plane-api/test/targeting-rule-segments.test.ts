import { envScope } from "@splitch/db";
import { describe, expect, it } from "vitest";
import {
  h,
  ids,
  kvFlag,
  NOW,
  replaceRules,
  request,
  seedSegment,
  segmentRequest,
  segmentRule,
  useTargetingRuleSegmentsHarness,
} from "./targeting-rule-segments-harness";

useTargetingRuleSegmentsHarness();

describe("Targeting Rule Segment references", () => {
  it("AND-merges Segment and direct Conditions into ordered KV rules without Segment ids", async () => {
    await seedSegment("segment_paid", "paid");
    const response = await replaceRules(
      ids.environmentId,
      {
        ...segmentRule("segment_paid"),
        conditions: [{ attribute: "country", operator: "eq", value: "US" }],
      },
      "publish",
    );
    expect(response.status).toBe(200);

    const authoring = await h.repo.flags.listTargetingRules(
      envScope(ids.appId, ids.environmentId),
      ids.flagId,
    );
    expect(authoring[0]?.segmentId).toBe("segment_paid");

    const projection = await kvFlag(ids.environmentId);
    expect(projection.targetingRules).toEqual([
      expect.objectContaining({
        priority: 0,
        conditions: [
          { attribute: "country", operator: "eq", value: "US" },
          { attribute: "plan", operator: "eq", value: "paid" },
        ],
      }),
    ]);
    expect(JSON.stringify(projection.targetingRules)).not.toContain("segmentId");
  });
});

describe("Targeting Rule Segment lifecycle", () => {
  it("returns typed failures for a dangling Segment and lets Targeting PUT repair it", async () => {
    await seedSegment("segment_dangling", "paid");
    expect(
      (await replaceRules(ids.environmentId, segmentRule("segment_dangling"), "dangling")).status,
    ).toBe(200);
    h.repo.flags.listSegmentsByIds = async () => [];

    const read = await request(
      "GET",
      `/apps/${ids.appId}/envs/${ids.environmentId}/flags/${ids.flagId}/config`,
    );
    expect(read.status).toBe(404);
    expect(await read.json()).toMatchObject({
      code: "SEGMENT_NOT_FOUND",
      details: { missingSegmentIds: ["segment_dangling"] },
    });

    const promotion = await request(
      "POST",
      `/apps/${ids.appId}/envs/${ids.devEnvironmentId}/flags/${ids.flagId}/promote`,
      {
        fromEnvironmentId: ids.environmentId,
        select: { targeting: true },
        idempotency_key: "dangling_promotion",
      },
      "dangling_promotion",
    );
    expect(promotion.status).toBe(404);
    expect(await promotion.json()).toMatchObject({
      code: "SEGMENT_NOT_FOUND",
      details: { missingSegmentIds: ["segment_dangling"] },
    });

    const repaired = await replaceRules(
      ids.environmentId,
      {
        ...segmentRule(undefined, "rule_repaired"),
        conditions: [{ attribute: "country", operator: "eq", value: "US" }],
      },
      "repair_dangling",
    );
    expect(repaired.status).toBe(200);
  });

  it("Promotion preserves the authoring Segment and publishes its resolved projection", async () => {
    await seedSegment("segment_paid", "paid");
    expect(
      (await replaceRules(ids.devEnvironmentId, segmentRule("segment_paid"), "source")).status,
    ).toBe(200);

    const response = await request(
      "POST",
      `/apps/${ids.appId}/envs/${ids.environmentId}/flags/${ids.flagId}/promote`,
      {
        fromEnvironmentId: ids.devEnvironmentId,
        select: { targeting: true },
        idempotency_key: "segment_promotion",
      },
      "segment_promotion",
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      config: { targetingRules: [expect.objectContaining({ segmentId: "segment_paid" })] },
    });
    expect(
      (await h.repo.flags.listTargetingRules(envScope(ids.appId, ids.environmentId), ids.flagId))[0]
        ?.segmentId,
    ).toBe("segment_paid");
    const projection = await kvFlag(ids.environmentId);
    expect(projection.targetingRules[0]?.conditions).toEqual([
      { attribute: "plan", operator: "eq", value: "paid" },
    ]);
    expect(JSON.stringify(projection.targetingRules)).not.toContain("segmentId");
  });

  it("names mutable dependents, then permits deletion when only a frozen Run remains", async () => {
    await seedSegment("segment_paid", "paid");
    await replaceRules(ids.environmentId, segmentRule("segment_paid"), "dependency");
    await h.repo.experiments.updateExperiment(
      envScope(ids.appId, ids.environmentId),
      ids.experimentId,
      {
        draftTargetingRules: JSON.stringify([segmentRule("segment_paid")]),
        updatedAt: NOW,
      },
      ids.liveRunId,
    );

    const blocked = await segmentRequest("DELETE", "segment_paid");
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toMatchObject({
      code: "RESOURCE_NOT_EMPTY",
      details: {
        childType: "flag-config",
        childCount: 1,
        childCounts: { "flag-config": 1, "experiment-draft": 1 },
        segmentDependencies: {
          flagConfigurations: [
            expect.objectContaining({
              flagId: ids.flagId,
              environmentId: ids.environmentId,
            }),
          ],
          experimentDrafts: [
            expect.objectContaining({
              experimentId: ids.experimentId,
              experimentName: "Checkout experiment",
              environmentName: "Production",
            }),
          ],
        },
      },
    });

    await h.repo.flags.replaceTargetingRules(
      envScope(ids.appId, ids.environmentId),
      ids.flagId,
      [],
    );
    await h.repo.experiments.updateExperiment(
      envScope(ids.appId, ids.environmentId),
      ids.experimentId,
      { draftTargetingRules: "[]", status: "running", updatedAt: NOW },
      ids.liveRunId,
    );
    await h.d1
      .prepare("UPDATE runs SET targeting_rules = ? WHERE app_id = ? AND id = ?")
      .bind(
        JSON.stringify([
          {
            ...segmentRule(undefined),
            conditions: [{ attribute: "plan", operator: "eq", value: "paid" }],
          },
        ]),
        ids.appId,
        ids.liveRunId,
      )
      .run();

    expect((await segmentRequest("DELETE", "segment_paid")).status).toBe(200);
  });
});
