import { activationConfigKey, type FlagConfigKV, flagConfigKey } from "@splitch/contracts";
import { appScope, envScope } from "@splitch/db";
import { configSnapshotProvider, evaluatePath } from "@splitch/evaluation-core";
import { beforeEach, expect, it } from "vitest";
import { type ConfigStoreWriter, makeConfigStore } from "../src/config-store";
import { makeSnapshotRevisionCounter } from "../src/config-store-fixture-data";
import { type Harness, ids, NOW_MS, startSeededExperiment } from "../src/config-store-harness-core";
import { parseFlagConfigEnvelope } from "../src/config-store-kv";
import { makeConfigStoreProjectionJournalFixture } from "../src/config-store-projection-journal-fixture";
import { buildSnapshotFromD1 } from "../src/config-store-snapshot-build";
import { makePoolHarness } from "./config-store-pool-harness";

let h: Harness;
let store: ConfigStoreWriter;
const target = { appId: ids.appId, environmentId: ids.devEnvironmentId, flagId: ids.flagId };
const sourceScope = envScope(ids.appId, ids.environmentId);
const targetScope = envScope(ids.appId, target.environmentId);
const input = {
  ...target,
  actor: { ref: "user_sync", via: "session" } as const,
  fromEnvironmentId: ids.environmentId,
  initialConfig: { defaultVariantId: ids.controlVariantId },
};

beforeEach(async () => {
  h = await makePoolHarness();
  await h.d1
    .prepare(
      "UPDATE environments SET expires_at = ?, synced_from_environment_id = 'env_prod', synced_at = '2026-07-01T20:00:00.000Z' WHERE id = ?",
    )
    .bind("2026-07-02T20:00:00.000Z", target.environmentId)
    .run();
  store = makeConfigStore({
    projectionJournal: makeConfigStoreProjectionJournalFixture(),
    repo: h.repo,
    kv: h.kv,
    now: () => new Date(NOW_MS),
    broadcaster: { broadcast() {} },
    nextSnapshotRevision: makeSnapshotRevisionCounter(),
  });
});

it("copies the complete authoring config, both salts, Segment refs, and per-Environment default", async () => {
  await h.repo.flags.updateFlagConfig(sourceScope, ids.flagId, {
    enabled: true,
    defaultVariantId: ids.treatmentVariantId,
    availableVariantNames: JSON.stringify(["control", "treatment"]),
    rollout: JSON.stringify({ percentage: 37, salt: "same-baseline-cohort" }),
  });
  await h.repo.flags.segments.insert(appScope(ids.appId), {
    id: "seg_sync",
    appId: ids.appId,
    key: "sync-pro",
    name: "Pro",
    conditions: JSON.stringify([{ attribute: "plan", operator: "eq", value: "pro" }]),
    createdAt: new Date(NOW_MS).toISOString(),
    updatedAt: new Date(NOW_MS).toISOString(),
  });
  await h.repo.flags.targetingRules.insert(sourceScope, {
    id: "rule_sync",
    appId: ids.appId,
    environmentId: ids.environmentId,
    flagId: ids.flagId,
    priority: 2,
    segmentId: "seg_sync",
    conditions: "[]",
    variantId: ids.controlVariantId,
    percentageRollout: JSON.stringify({ percentage: 14, salt: "same-rule-cohort" }),
    createdAt: new Date(NOW_MS).toISOString(),
    updatedAt: new Date(NOW_MS).toISOString(),
  });
  const synced = await store.syncFlagConfig(input);
  expect(synced).toMatchObject({
    ok: true,
    config: {
      enabled: true,
      availableVariantNames: ["control", "treatment"],
      rollout: { percentage: 37, salt: "same-baseline-cohort" },
      targetingRules: [
        {
          id: "rule_sync",
          priority: 2,
          segmentId: "seg_sync",
          conditions: [],
          variantId: ids.controlVariantId,
          percentageRollout: { percentage: 14, salt: "same-rule-cohort" },
        },
      ],
    },
  });
  const config = await h.repo.flags.getFlagConfig(targetScope, ids.flagId);
  expect(config).toMatchObject({
    defaultVariantId: ids.treatmentVariantId,
    updatedBy: "user_sync",
    updatedVia: "session",
  });
  expect(JSON.parse(await snapshotText())).toMatchObject({
    data: {
      defaultVariantId: ids.treatmentVariantId,
      targetingRules: [
        {
          conditions: [{ attribute: "plan", operator: "eq", value: "pro" }],
          percentageRollout: { percentage: 14, salt: "same-rule-cohort" },
        },
      ],
    },
  });
  expect(await store.syncFlagConfig(input)).toMatchObject({
    ok: true,
    config: {
      enabled: true,
      rollout: { percentage: 37, salt: "same-baseline-cohort" },
      targetingRules: [
        { id: "rule_sync", percentageRollout: { percentage: 14, salt: "same-rule-cohort" } },
      ],
    },
  });
  const source = await buildSnapshotFromD1(h.repo, sourceScope, ids.flagId);
  if (!source) throw new Error("source fixture missing");
  const copied = parseFlagConfigEnvelope(await snapshotText());
  for (const plan of ["free", "pro"]) {
    const original = await buckets(source.flag, plan);
    const temporary = await buckets(copied, plan);
    expect(temporary).toEqual(original);
    expect(new Set(temporary.map((result) => result.variant))).toEqual(
      new Set(["control", "treatment"]),
    );
    expect(new Set(temporary.map((result) => result.kind))).toEqual(
      new Set([plan === "pro" ? "rule_match_percentage" : "baseline_rollout"]),
    );
  }
});

async function buckets(flag: FlagConfigKV, plan: string) {
  const provider = configSnapshotProvider(
    {
      schemaVersion: 1,
      environmentVersion: 1,
      appId: ids.appId,
      environmentId: flag.environmentId,
      flags: [flag],
      experiments: [],
      runs: [],
    },
    "Sync parity fixture",
  );
  const results = [];
  for (let i = 0; i < 64; i++) {
    results.push(
      await evaluatePath(
        {
          appId: ids.appId,
          environmentId: flag.environmentId,
          flagKey: ids.flagKey,
          evaluationContext: {
            idType: "user",
            targetingKey: `sync-user-${i}`,
            attributes: { plan },
          },
        },
        {
          provider,
          assignmentStore: {
            getAll: async () => {
              throw new Error("a copied Flag must never read an assignment");
            },
            put: async () => {
              throw new Error("a copied Flag must never write an assignment");
            },
            putHashed: async () => {
              throw new Error("a copied Flag must never write an assignment");
            },
          },
        },
      ),
    );
  }
  return results;
}

it("copies config under a live source Run without publishing a Run or Activation bindings", async () => {
  await h.repo.flags.updateFlagConfig(sourceScope, ids.flagId, { enabled: true });
  await startSeededExperiment(h.d1);
  await h.kv.put(activationConfigKey(ids.appId, target.environmentId), "stale activation");
  expect(await store.syncFlagConfig(input)).toMatchObject({
    ok: true,
    config: { enabled: true, experiment: null },
  });
  expect(JSON.parse(await snapshotText())).toMatchObject({
    data: { experimentId: null, enabled: true },
  });
  expect(await h.kv.get(activationConfigKey(ids.appId, target.environmentId))).toBeNull();
  expect(await h.repo.experiments.listExperiments(targetScope)).toEqual([]);
});

it("replaces target overrides with initial configuration when the source config is missing", async () => {
  await h.repo.flags.removeFlagConfig(sourceScope, ids.flagId);
  expect(await store.syncFlagConfig(input)).toMatchObject({
    ok: true,
    config: {
      enabled: false,
      availableVariantNames: [],
      targetingRules: [],
      rollout: null,
      experiment: null,
    },
  });
  expect(await h.repo.flags.getFlagConfig(targetScope, ids.flagId)).toMatchObject({
    defaultVariantId: ids.controlVariantId,
  });
});

async function snapshotText(): Promise<string> {
  const raw = await h.kv.get(flagConfigKey(ids.appId, target.environmentId, ids.flagKey));
  if (raw === null) throw new Error("Sync snapshot fixture missing");
  return raw;
}
