import { appScope, type EnvScope, envScope } from "@splitch/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startSeededExperiment } from "../src/config-store-fixture-data";
import type { Harness } from "../src/config-store-harness-core";
import { ids } from "../src/config-store-harness-core";
import {
  buildEvaluationSnapshotFromD1,
  buildSnapshotFromD1,
} from "../src/config-store-snapshot-build";
import { makePoolHarness as makeHarness } from "./config-store-pool-harness";

let h: Harness;

beforeEach(async () => {
  h = await makeHarness();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await h.dispose();
});

const NOW = "2026-07-01T18:00:00.000Z";

describe("config store evaluation snapshot read", () => {
  it("builds the same snapshot by Flag key as by Flag id", async () => {
    await startSeededExperiment(h.d1);
    const scope = envScope(ids.appId, ids.environmentId);

    const byKey = await buildEvaluationSnapshotFromD1(h.repo, scope, ids.flagKey);

    expect(byKey).toMatchObject({ run: { id: ids.liveRunId } });
    expect(byKey).toEqual(await buildSnapshotFromD1(h.repo, scope, ids.flagId));
  });

  // Each case pins the by-id outcome too, so two reads failing alike for an
  // unrelated reason cannot pass as agreement.
  it.each([
    ["a draft Experiment", envScope(ids.appId, ids.environmentId), noSetup, 0],
    ["Targeting Rules", envScope(ids.appId, ids.devEnvironmentId), noSetup, 1],
    ["a Segment-backed Rule", envScope(ids.appId, ids.devEnvironmentId), seedSegmentRule, 2],
    ["no Configuration", envScope(ids.appId, "env_unconfigured"), seedBareEnvironment, null],
    ["a missing live Run", envScope(ids.appId, ids.environmentId), loseLiveRun, "rejects"],
    ["two running Experiments", envScope(ids.appId, ids.environmentId), runTwo, "rejects"],
  ] as const)("agrees with the by-id read for %s", async (_case, scope, arrange, rules) => {
    await arrange();

    const [byKey, byId] = await Promise.allSettled([
      buildEvaluationSnapshotFromD1(h.repo, scope, ids.flagKey),
      buildSnapshotFromD1(h.repo, scope, ids.flagId),
    ]);

    if (rules === "rejects") {
      expect([byKey.status, byId.status]).toEqual(["rejected", "rejected"]);
      return;
    }
    expect(byKey).toEqual(byId);
    const snapshot = byId.status === "fulfilled" ? byId.value : undefined;
    expect(snapshot === null ? null : snapshot?.authoringTargetingRules.length).toBe(rules);
  });

  it("returns null for a key the App does not hold", async () => {
    await expect(
      buildEvaluationSnapshotFromD1(
        h.repo,
        envScope(ids.appId, ids.environmentId),
        "no-such-flag-key",
      ),
    ).resolves.toBeNull();
  });

  it("re-reads by id when the key moved to another Flag mid-read", async () => {
    const scope = envScope(ids.appId, ids.environmentId);
    vi.spyOn(h.repo.flagEvaluation, "readFlagSnapshotInputsByKey").mockResolvedValue("moved");
    const getFlagByKey = vi.spyOn(h.repo.flags, "getFlagByKey");

    const snapshot = await buildEvaluationSnapshotFromD1(h.repo, scope, ids.flagKey);

    expect(getFlagByKey).toHaveBeenCalledOnce();
    expect(snapshot).toEqual(await buildSnapshotFromD1(h.repo, scope, ids.flagId));
  });
});

async function noSetup(): Promise<void> {}

async function seedSegmentRule(): Promise<void> {
  await h.repo.flags.segments.insert(appScope(ids.appId), {
    id: "seg_pro",
    appId: ids.appId,
    name: "Pro plans",
    conditions: JSON.stringify([{ attribute: "plan", operator: "eq", value: "pro" }]),
    createdAt: NOW,
    updatedAt: NOW,
  });
  await h.repo.flags.targetingRules.insert(envScope(ids.appId, ids.devEnvironmentId), {
    id: "rule_checkout_dev_segment",
    appId: ids.appId,
    environmentId: ids.devEnvironmentId,
    flagId: ids.flagId,
    priority: 1,
    conditions: "[]",
    segmentId: "seg_pro",
    variantId: ids.controlVariantId,
    createdAt: NOW,
    updatedAt: NOW,
  });
}

async function seedBareEnvironment(): Promise<void> {
  await h.repo.identity.environments.insert(appScope(ids.appId), {
    id: "env_unconfigured",
    appId: ids.appId,
    key: "unconfigured",
    name: "QA",
    createdAt: NOW,
    updatedAt: NOW,
  });
}

async function loseLiveRun(): Promise<void> {
  await startSeededExperiment(h.d1);
  await h.d1
    .prepare("UPDATE experiments SET live_run_id = 'run_missing' WHERE app_id = ? AND id = ?")
    .bind(ids.appId, ids.experimentId)
    .run();
}

async function runTwo(): Promise<void> {
  await startSeededExperiment(h.d1);
  const scope: EnvScope = envScope(ids.appId, ids.environmentId);
  await h.repo.experiments.experiments.insert(scope, {
    id: "exp_checkout_duplicate",
    appId: ids.appId,
    environmentId: ids.environmentId,
    key: "checkout-exp-duplicate",
    flagId: ids.flagId,
    name: "Duplicate checkout experiment",
    status: "running",
    targetingKeyField: "userId",
    targetingKeyType: "user",
    metrics: "[]",
    guardrailMetrics: "[]",
    dimensions: "[]",
    createdAt: NOW,
    updatedAt: NOW,
  });
}
