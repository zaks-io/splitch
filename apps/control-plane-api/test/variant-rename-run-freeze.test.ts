import { flagConfigKey, runConfigKey } from "@splitch/contracts";
import { appScope, envScope } from "@splitch/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeConfigStore } from "../src/config-store";
import { startSeededExperiment } from "../src/config-store-fixture-data";
import {
  type Harness,
  ids,
  kvJson,
  NOW,
  NOW_MS,
  setProdPolicy,
} from "../src/config-store-harness-core";
import { allowPolicy, confirmPolicy, patchVariant, reviewRequest } from "./approval-harness";
import { makePoolHarness } from "./config-store-pool-harness";

/**
 * SPL-267. A live Run freezes `flagConfig.availableVariantNames`, and SPL-118
 * refuses any write that strips a live Run's arm out of the servable set.
 * RENAMING the Variant removes the same arm by another name, and the rename
 * carries into every Environment's available set by design (ADR-0028: the
 * catalog is App-level).
 *
 * Both doors are exercised: the direct PATCH, and a proposal filed BEFORE Start
 * and approved AFTER it.
 */

let h: Harness;

/**
 * Deliberately UNEQUAL per-Environment fixtures. An identical seed in two
 * Environments once hid a cross-boundary write in this repo entirely, so `dev`
 * carries a Variant `prod` cannot serve and each Environment's available set is
 * distinguishable in any assertion that reads it.
 */
const CANARY_VARIANT_ID = "var_canary";

async function seedDistinctEnvironments(): Promise<void> {
  await h.repo.flags.addVariant(appScope(ids.appId), ids.flagId, {
    id: CANARY_VARIANT_ID,
    name: "canary",
    value: JSON.stringify("canary-only"),
    createdAt: NOW,
  });
  await setAvailable(ids.environmentId, ["control", "treatment"]);
  await setAvailable(ids.devEnvironmentId, ["canary", "control", "treatment"]);
}

async function setAvailable(envId: string, names: string[]): Promise<void> {
  await h.d1
    .prepare(
      "UPDATE flag_configs SET available_variant_names = ? WHERE app_id = ? AND environment_id = ?",
    )
    .bind(JSON.stringify(names), ids.appId, envId)
    .run();
}

async function availableNames(envId: string): Promise<unknown> {
  const config = await h.repo.flags.getFlagConfig(envScope(ids.appId, envId), ids.flagId);
  return JSON.parse(config?.availableVariantNames ?? "[]");
}

async function configVersion(envId: string): Promise<number | undefined> {
  const config = await h.repo.flags.getFlagConfig(envScope(ids.appId, envId), ids.flagId);
  return config?.version;
}

beforeEach(async () => {
  h = await makePoolHarness();
  await seedDistinctEnvironments();
  await h.repo.flags.updateFlagConfig(envScope(ids.appId, ids.environmentId), ids.flagId, {
    enabled: true,
    updatedAt: "2026-07-02T09:00:00.000Z",
  });
});

afterEach(async () => {
  await h.dispose();
});

describe("ATTACK 1 — the direct PATCH renames a live Run's arm", () => {
  it("refuses the rename while run_live is live", async () => {
    await setProdPolicy(h, allowPolicy);
    await startSeededExperiment(h.d1);

    const renamed = await patchVariant(h, "treatment", "spl267_direct", {
      name: "treatment_pwned",
    });

    console.log("ATTACK-1 RENAME RESPONSE:", JSON.stringify(renamed));
    console.log(
      "ATTACK-1 prod available:",
      JSON.stringify(await availableNames(ids.environmentId)),
    );
    console.log(
      "ATTACK-1 dev  available:",
      JSON.stringify(await availableNames(ids.devEnvironmentId)),
    );
    console.log("ATTACK-1 prod version:", await configVersion(ids.environmentId));

    expect(renamed.status).toBe(409);
    expect(renamed.code).toBe("RUN_FROZEN");
    const variant = await h.repo.flags.getVariantById(appScope(ids.appId), ids.treatmentVariantId);
    expect(variant?.name).toBe("treatment");
    expect(await availableNames(ids.environmentId)).toEqual(["control", "treatment"]);
    expect(await availableNames(ids.devEnvironmentId)).toEqual(["canary", "control", "treatment"]);
  });
});

describe("ATTACK 2 — a proposal filed before Start, approved after", () => {
  it("refuses at Review time, when the Run is live", async () => {
    await setProdPolicy(h, confirmPolicy);

    const proposed = await patchVariant(h, "treatment", "spl267_late", { name: "treatment_late" });
    expect(proposed.code).toBe("APPROVAL_REVIEW_REQUIRED");

    // The Run starts between the proposal and its Review.
    await startSeededExperiment(h.d1);

    const applied = await reviewRequest(h, proposed.approvalRequestId as string, "spl267_late_r");
    const body = await applied.json();
    console.log("ATTACK-2 REVIEW STATUS:", applied.status, JSON.stringify(body));
    console.log(
      "ATTACK-2 prod available:",
      JSON.stringify(await availableNames(ids.environmentId)),
    );

    expect(applied.status).toBeGreaterThanOrEqual(400);
    const variant = await h.repo.flags.getVariantById(appScope(ids.appId), ids.treatmentVariantId);
    expect(variant?.name).toBe("treatment");
    expect(await availableNames(ids.environmentId)).toEqual(["control", "treatment"]);
  });
});

/**
 * The consequence the refusal exists to prevent, asserted on the published KV
 * blobs the edge actually reads.
 *
 * Before the guard these two disagreed: the Flag snapshot's catalog said
 * `treatment_pwned` while the Run's frozen `allocation` still sent half its
 * traffic to `treatment`, and `apps/evaluation-api/src/evaluate-renamed-run-arm.test.ts`
 * executes what that costs — INTERNAL_SERVER_ERROR for that share of traffic.
 */
describe("BLAST RADIUS — the KV snapshot a live Run's traffic resolves against", () => {
  it("keeps the published catalog naming every arm the frozen allocation uses", async () => {
    await setProdPolicy(h, allowPolicy);
    await startSeededExperiment(h.d1);

    // Publish the live Run to KV the way Start does, so the blobs below are the
    // ones a real evaluate would read rather than a hand-built fixture.
    const store = makeConfigStore({
      repo: h.repo,
      kv: h.kv,
      broadcaster: { broadcast: () => undefined },
      now: () => new Date(NOW_MS),
    });
    const synced = await store.syncExperimentConfig({
      appId: ids.appId,
      environmentId: ids.environmentId,
      experimentId: ids.experimentId,
    });
    console.log("BLAST sync:", JSON.stringify(synced.ok));

    const renamed = await patchVariant(h, "treatment", "spl267_blast", {
      name: "treatment_pwned",
    });
    console.log("BLAST rename response:", JSON.stringify(renamed));
    expect(renamed.status).toBe(409);

    const flagBlob = (await kvJson(
      h.kv,
      flagConfigKey(ids.appId, ids.environmentId, ids.flagKey),
    )) as { data: { variants: { name: string }[]; availableVariantNames: string[] } };
    const runBlob = (await kvJson(
      h.kv,
      runConfigKey(ids.appId, ids.environmentId, ids.liveRunId),
    )) as { data: { allocation: Record<string, number> } };

    const catalog = flagBlob.data.variants.map((variant) => variant.name);
    console.log("BLAST KV flag catalog:", JSON.stringify(catalog));
    console.log("BLAST KV available:", JSON.stringify(flagBlob.data.availableVariantNames));
    console.log("BLAST KV run allocation:", JSON.stringify(runBlob.data.allocation));

    // Every arm the frozen allocation can select must still resolve to a Variant
    // in the published catalog; an arm that does not is the 500.
    for (const arm of Object.keys(runBlob.data.allocation)) {
      expect(catalog).toContain(arm);
      expect(flagBlob.data.availableVariantNames).toContain(arm);
    }
  });
});
