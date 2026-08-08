import { flagConfigKey } from "@splitch/contracts";
import { appScope, envScope } from "@splitch/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { narrowSeededAvailability } from "../src/config-store-fixture-data";
import { type Harness, ids, NOW, token } from "../src/config-store-harness-core";
import { makePoolHarness } from "./config-store-pool-harness";

let h: Harness;

beforeEach(async () => {
  h = await makePoolHarness();
  await narrowSeededAvailability(h.d1);
});

afterEach(async () => {
  await h.dispose();
});

describe("Targeting Rule Segment references", () => {
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
  });
});

describe("Targeting Rule Segment lifecycle", () => {
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

function segmentRule(segmentId: string | undefined, id = "rule_segment_paid") {
  return {
    id,
    flagId: ids.flagId,
    priority: 0,
    conditions: [],
    ...(segmentId ? { segmentId } : {}),
    variantId: ids.treatmentVariantId,
    percentageRollout: null,
  };
}

async function seedSegment(id: string, plan: string) {
  await h.repo.flags.segments.insert(appScope(ids.appId), {
    id,
    appId: ids.appId,
    name: "Paid plan",
    conditions: JSON.stringify([{ attribute: "plan", operator: "eq", value: plan }]),
    createdAt: NOW,
    updatedAt: NOW,
  });
}

async function replaceRules(environmentId: string, rule: object, suffix: string) {
  return request(
    "PUT",
    `/apps/${ids.appId}/envs/${environmentId}/flags/${ids.flagId}/targeting-rules`,
    {
      targetingRules: [rule],
      idempotency_key: `segment_rules_${suffix}`,
    },
    `segment_rules_${suffix}`,
  );
}

async function segmentRequest(method: "PATCH" | "DELETE", segmentId: string, body?: object) {
  return request(method, `/apps/${ids.appId}/segments/${segmentId}`, body);
}

async function request(method: string, path: string, body?: object, idempotencyKey?: string) {
  const jwt = await token(h.signer);
  return h.app.request(path, {
    method,
    headers: {
      authorization: `Bearer ${jwt}`,
      ...(body ? { "content-type": "application/json" } : {}),
      ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

async function kvFlag(environmentId: string) {
  const raw = await h.kv.get(flagConfigKey(ids.appId, environmentId, ids.flagKey), "json");
  if (!raw || typeof raw !== "object" || !("data" in raw)) throw new Error("KV Flag missing");
  return raw.data as { targetingRules: Array<{ conditions: unknown[] }> };
}
