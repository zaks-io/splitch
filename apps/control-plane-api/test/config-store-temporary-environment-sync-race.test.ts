import { flagConfigKey } from "@splitch/contracts";
import { createRepository, envScope } from "@splitch/db";
import { beforeEach, expect, it } from "vitest";
import { makeConfigStore } from "../src/config-store";
import { makeSnapshotRevisionCounter } from "../src/config-store-fixture-data";
import { type Harness, ids, NOW, NOW_MS } from "../src/config-store-harness-core";
import { parseFlagConfigEnvelope } from "../src/config-store-kv";
import { makeConfigStoreProjectionJournalFixture } from "../src/config-store-projection-journal-fixture";
import { makePoolHarness } from "./config-store-pool-harness";

let h: Harness;
const sourceScope = envScope(ids.appId, ids.environmentId);
const targetScope = envScope(ids.appId, ids.devEnvironmentId);
const input = {
  appId: ids.appId,
  environmentId: ids.devEnvironmentId,
  flagId: ids.flagId,
  fromEnvironmentId: ids.environmentId,
  initialConfig: { defaultVariantId: ids.controlVariantId },
  actor: { ref: "user_atomic_sync", via: "session" } as const,
};

beforeEach(async () => {
  h = await makePoolHarness();
  await h.d1
    .prepare(
      "UPDATE environments SET expires_at = ?, synced_from_environment_id = ?, synced_at = ? WHERE id = ?",
    )
    .bind(new Date(NOW_MS + 60_000).toISOString(), ids.environmentId, NOW, ids.devEnvironmentId)
    .run();
  await replaceSource("before");
});

async function replaceSource(state: "before" | "after") {
  const after = state === "after";
  const result = await h.repo.flags.replaceTargetingRules(
    sourceScope,
    ids.flagId,
    [
      {
        id: `rule_${state}`,
        priority: 0,
        segmentId: null,
        conditions: JSON.stringify([{ attribute: "plan", operator: "eq", value: state }]),
        variantId: after ? ids.treatmentVariantId : ids.controlVariantId,
        percentageRollout: JSON.stringify({ percentage: after ? 83 : 17, salt: `rule-${state}` }),
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
    {
      enabled: after,
      availableVariantNames: JSON.stringify(after ? [] : ["control", "treatment"]),
      defaultVariantId: after ? ids.treatmentVariantId : ids.controlVariantId,
      rollout: JSON.stringify({ percentage: after ? 71 : 29, salt: `baseline-${state}` }),
      updatedAt: NOW,
    },
  );
  expect(result).toMatchObject({ ok: true });
}

it.each(["before", "after"] as const)(
  "copies one complete source state when an atomic source replacement commits %s its read batch",
  async (timing) => {
    let intercepted = false;
    const batch = async (statements: D1PreparedStatement[]) => {
      if (intercepted) return h.d1.batch(statements);
      intercepted = true;
      expect(statements).toHaveLength(2);
      if (timing === "before") await replaceSource("after");
      const result = await h.d1.batch(statements);
      if (timing === "after") await replaceSource("after");
      return result;
    };
    const d1 = new Proxy(h.d1, {
      get(target, property) {
        if (property === "batch") return batch;
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const writer = makeConfigStore({
      projectionJournal: makeConfigStoreProjectionJournalFixture(),
      repo: createRepository(d1),
      kv: h.kv,
      broadcaster: { broadcast() {} },
      nextSnapshotRevision: makeSnapshotRevisionCounter(),
      now: () => new Date(NOW_MS),
    });
    const result = await writer.syncFlagConfig(input);
    expect(intercepted).toBe(true);
    const copiedState = timing === "before" ? "after" : "before";
    const after = copiedState === "after";
    expect(result).toMatchObject({
      ok: true,
      config: {
        enabled: after,
        availableVariantNames: after ? [] : ["control", "treatment"],
        rollout: { percentage: after ? 71 : 29, salt: `baseline-${copiedState}` },
        targetingRules: [
          {
            id: `rule_${copiedState}`,
            conditions: [{ attribute: "plan", operator: "eq", value: copiedState }],
            variantId: after ? ids.treatmentVariantId : ids.controlVariantId,
            percentageRollout: { percentage: after ? 83 : 17, salt: `rule-${copiedState}` },
          },
        ],
      },
    });
    expect(await h.repo.flags.getFlagConfig(targetScope, ids.flagId)).toMatchObject({
      defaultVariantId: after ? ids.treatmentVariantId : ids.controlVariantId,
    });
    const raw = await h.kv.get(flagConfigKey(ids.appId, input.environmentId, ids.flagKey));
    if (!raw) throw new Error("copied evaluation snapshot is missing");
    expect(parseFlagConfigEnvelope(raw)).toMatchObject({
      enabled: after,
      defaultVariantId: after ? ids.treatmentVariantId : ids.controlVariantId,
      rollout: { salt: `baseline-${copiedState}` },
      targetingRules: [
        { id: `rule_${copiedState}`, percentageRollout: { salt: `rule-${copiedState}` } },
      ],
    });
    expect(
      await h.repo.flags.getFlagConfigWithTargetingRules(sourceScope, ids.flagId),
    ).toMatchObject({
      config: { enabled: true, defaultVariantId: ids.treatmentVariantId },
      targetingRules: [{ id: "rule_after" }],
    });
  },
);
