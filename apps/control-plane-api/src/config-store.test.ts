import {
  CURRENT_KV_SCHEMA_VERSION,
  experimentConfigKey,
  flagConfigKey,
  runConfigKey,
} from "@splitch/contracts";
import { appScope } from "@splitch/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeConfigStore } from "./config-store";
import {
  authedPatch,
  faultingCommitRepo,
  type Harness,
  ids,
  kvJson,
  makeAuthedApp,
  makeHarness,
  NOW,
  NOW_MS,
  patchFlagConfig,
  promoteFlagConfig,
  replaceTargetingRules,
  setProdPolicy,
  token,
} from "./config-store-test-harness";

let h: Harness;

const confirmPolicy = {
  variantAvailability: "confirm",
  targetingRolloutValue: "confirm",
  enabledState: "confirm",
  startExperimentRun: "confirm",
} as const;

beforeEach(async () => {
  h = await makeHarness();
});

afterEach(async () => {
  await h.dispose();
});

describe("config store write path", () => {
  it("commits D1, writes KV, then broadcasts a delta nudge", async () => {
    const res = await patchFlagConfig(h, { enabled: true, availableVariantNames: ["control"] });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      flagId: ids.flagId,
      environmentId: ids.environmentId,
      version: 2,
      enabled: true,
      availableVariantNames: ["control"],
    });

    expect(h.events.slice(0, 2)).toEqual(["d1-before-kv:true", "kv:flag"]);
    expect(h.events.at(-1)).toBe("broadcast");

    const flagEnvelope = await kvJson(
      h.kv,
      flagConfigKey(ids.appId, ids.environmentId, ids.flagKey),
    );
    expect(flagEnvelope).toMatchObject({
      schemaVersion: CURRENT_KV_SCHEMA_VERSION,
      data: { id: ids.flagId, enabled: true, experimentId: ids.experimentId },
    });

    const experimentEnvelope = await kvJson(
      h.kv,
      experimentConfigKey(ids.appId, ids.environmentId, ids.experimentId),
    );
    expect(experimentEnvelope).toMatchObject({
      data: { id: ids.experimentId, liveRunId: ids.liveRunId },
    });
    expect(
      await h.kv.get(runConfigKey(ids.appId, ids.environmentId, ids.liveRunId), "text"),
    ).toEqual(expect.any(String));
    expect(await h.kv.get(runConfigKey(ids.appId, ids.environmentId, ids.newerRunId), "text")).toBe(
      null,
    );

    expect(h.nudges).toEqual([
      { type: "config.changed", entity: "flag", id: ids.flagId, version: 2 },
    ]);
  });

  it("returns 500 with no KV write and no broadcast when D1 commit fails", async () => {
    const kvPut = vi.fn();
    const store = makeConfigStore({
      repo: faultingCommitRepo(h.repo),
      kv: { get: h.kv.get.bind(h.kv), put: kvPut } as unknown as KVNamespace,
      broadcaster: { broadcast: (nudge) => void h.nudges.push(nudge) },
      now: () => new Date(NOW_MS),
    });
    const app = makeAuthedApp(h, store);

    const res = await authedPatch(app, h.signer, { enabled: true });

    expect(res.status).toBe(500);
    expect(kvPut).not.toHaveBeenCalled();
    expect(h.nudges).toEqual([]);
  });

  it("accepts an owner token on the admin-gated write route (owner ⊇ admin)", async () => {
    // The claim ceremony mints `app:{appId}:owner` — the only scope a claimed
    // workspace's owner ever holds — so the admin gate must accept it.
    const jwt = await token(h.signer, [`app:${ids.appId}:owner`]);
    const res = await h.app.request(
      `/apps/${ids.appId}/envs/${ids.environmentId}/flags/${ids.flagId}/config`,
      {
        method: "PATCH",
        headers: { authorization: `Bearer ${jwt}`, "content-type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      },
    );
    expect(res.status).toBe(200);
  });

  it("rejects a member token before writing config", async () => {
    const jwt = await token(h.signer, [`app:${ids.appId}:member`]);
    const res = await h.app.request(
      `/apps/${ids.appId}/envs/${ids.environmentId}/flags/${ids.flagId}/config`,
      {
        method: "PATCH",
        headers: { authorization: `Bearer ${jwt}`, "content-type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      },
    );

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      code: "INSUFFICIENT_SCOPES",
      details: { requiredScopes: [`app:${ids.appId}:owner`, `app:${ids.appId}:admin`] },
    });
    expect(await h.kv.get(flagConfigKey(ids.appId, ids.environmentId, ids.flagKey), "text")).toBe(
      null,
    );
    expect(h.nudges).toEqual([]);
  });

  it("falls back to D1 on an unknown KV schemaVersion and logs the mismatch", async () => {
    const key = flagConfigKey(ids.appId, ids.environmentId, ids.flagKey);
    await h.kv.put(
      key,
      JSON.stringify({
        schemaVersion: 999,
        data: {
          id: ids.flagId,
          key: ids.flagKey,
          environmentId: ids.environmentId,
          experimentId: null,
          enabled: true,
          defaultVariantId: ids.controlVariantId,
          variants: [{ id: ids.controlVariantId, name: "control", value: "off" }],
          availableVariantNames: ["control"],
          targetingRules: [],
          updatedAt: NOW,
        },
      }),
    );

    const jwt = await token(h.signer);
    const res = await h.app.request(
      `/apps/${ids.appId}/envs/${ids.environmentId}/flags/${ids.flagId}/config`,
      { headers: { authorization: `Bearer ${jwt}` } },
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      version: 1,
      enabled: false,
      availableVariantNames: ["control", "treatment"],
    });
    expect(h.warnings).toHaveLength(1);

    const rewritten = await kvJson(h.kv, key);
    expect(rewritten).toMatchObject({
      schemaVersion: CURRENT_KV_SCHEMA_VERSION,
      data: { enabled: false, availableVariantNames: ["control", "treatment"] },
    });
  });
});

describe("config store variant catalog resync", () => {
  it("resyncFlagConfig rebuilds the KV snapshot after an app-scoped Variant value change", async () => {
    const store = makeConfigStore({
      repo: h.repo,
      kv: h.kv,
      broadcaster: { broadcast: (nudge) => void h.nudges.push(nudge) },
      now: () => new Date(NOW_MS),
    });
    const key = flagConfigKey(ids.appId, ids.environmentId, ids.flagKey);

    // Seed the KV snapshot, then change the treatment Variant's value in D1 only.
    await store.resyncFlagConfig({
      appId: ids.appId,
      environmentId: ids.environmentId,
      flagId: ids.flagId,
    });
    const before = (await kvJson(h.kv, key)) as {
      data: { variants: Array<{ name: string; value: unknown }> };
    };
    expect(before.data.variants.find((v) => v.name === "treatment")?.value).toBe("on");

    await h.repo.flags.updateVariant(appScope(ids.appId), ids.flagId, "treatment", {
      value: JSON.stringify("changed"),
    });

    // Without a resync the KV blob would still read "on"; resync must rewrite it.
    const result = await store.resyncFlagConfig({
      appId: ids.appId,
      environmentId: ids.environmentId,
      flagId: ids.flagId,
    });
    expect(result.ok).toBe(true);

    const after = (await kvJson(h.kv, key)) as {
      data: { variants: Array<{ name: string; value: unknown }> };
    };
    expect(after.data.variants.find((v) => v.name === "treatment")?.value).toBe("changed");
  });

  it("deleteFlagConfig removes the KV snapshot and broadcasts invalidation", async () => {
    const store = makeConfigStore({
      repo: h.repo,
      kv: h.kv,
      broadcaster: { broadcast: (nudge) => void h.nudges.push(nudge) },
      now: () => new Date(NOW_MS),
    });
    await store.resyncFlagConfig({
      appId: ids.appId,
      environmentId: ids.environmentId,
      flagId: ids.flagId,
    });
    const key = flagConfigKey(ids.appId, ids.environmentId, ids.flagKey);
    expect(await h.kv.get(key, "text")).toEqual(expect.any(String));

    const result = await store.deleteFlagConfig({
      appId: ids.appId,
      environmentId: ids.environmentId,
      flagId: ids.flagId,
    });
    expect(result.ok).toBe(true);
    expect(await h.kv.get(key, "text")).toBeNull();
    expect(h.nudges).toContainEqual(
      expect.objectContaining({
        type: "config.changed",
        entity: "flag",
        id: ids.flagId,
        version: 0,
      }),
    );

    const retry = await store.deleteFlagConfig({
      appId: ids.appId,
      environmentId: ids.environmentId,
      flagId: ids.flagId,
      flagKey: ids.flagKey,
    });
    expect(retry.ok).toBe(true);
  });

  it("resyncFlagConfig reports FLAG_NOT_FOUND when the Environment has no config for the Flag", async () => {
    const store = makeConfigStore({
      repo: h.repo,
      kv: h.kv,
      broadcaster: { broadcast: (nudge) => void h.nudges.push(nudge) },
      now: () => new Date(NOW_MS),
    });

    // No flag_config exists for an unknown flag, so there is nothing to resync.
    const result = await store.resyncFlagConfig({
      appId: ids.appId,
      environmentId: ids.environmentId,
      flagId: "flag_does_not_exist",
    });
    expect(result).toEqual({ ok: false, reason: "FLAG_NOT_FOUND" });
  });
});

describe("flag configuration and promotion routes", () => {
  it("replaces Targeting Rules through the config-store write path", async () => {
    const res = await replaceTargetingRules(h, {
      targetingRules: [
        {
          id: "rule_prod_treatment",
          flagId: ids.flagId,
          priority: 0,
          conditions: [{ attribute: "plan", operator: "eq", value: "pro" }],
          variantId: ids.treatmentVariantId,
        },
      ],
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      version: 2,
      targetingRules: [
        expect.objectContaining({
          id: "rule_prod_treatment",
          variantId: ids.treatmentVariantId,
        }),
      ],
    });
    expect(h.events.slice(0, 2)).toEqual(["d1-before-kv:false", "kv:flag"]);
    expect(h.events.at(-1)).toBe("broadcast");
  });

  it("returns CONFIRMATION_REQUIRED for a Policy-gated PATCH without confirm", async () => {
    await setProdPolicy(h, confirmPolicy);

    const res = await patchFlagConfig(h, { availableVariantNames: ["control"] });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      code: "CONFIRMATION_REQUIRED",
      details: {
        gate: "variant_availability",
        environmentId: ids.environmentId,
        attemptedOp: "PATCH_FLAG_CONFIG",
        recommendedAction: "RETRY_WITH_CONFIRMATION",
      },
    });
    expect(h.nudges).toEqual([]);
  });

  it("accepts enabled-off as an ungated kill switch", async () => {
    await setProdPolicy(h, confirmPolicy);

    const enable = await patchFlagConfig(h, { enabled: true, confirm: true });
    expect(enable.status).toBe(200);

    const disable = await patchFlagConfig(h, { enabled: false });

    expect(disable.status).toBe(200);
    expect(await disable.json()).toMatchObject({ enabled: false });
  });

  it("promotes selected config field-groups and returns a before/after diff", async () => {
    const res = await promoteFlagConfig(h, {
      fromEnvironmentId: ids.devEnvironmentId,
      select: { targeting: true, enabled: true },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      config: {
        flagId: ids.flagId,
        environmentId: ids.environmentId,
        enabled: true,
        targetingRules: [
          expect.objectContaining({
            variantId: ids.treatmentVariantId,
          }),
        ],
      },
      diff: {
        before: { enabled: false, targetingRules: [] },
        after: {
          enabled: true,
          targetingRules: [
            expect.objectContaining({
              variantId: ids.treatmentVariantId,
            }),
          ],
        },
      },
    });
    expect(h.events.slice(0, 2)).toEqual(["d1-before-kv:true", "kv:flag"]);
    expect(h.events.at(-1)).toBe("broadcast");
  });

  it("rejects promoted Targeting Rules that route to an unavailable Variant", async () => {
    const narrow = await patchFlagConfig(h, { availableVariantNames: ["control"] });
    expect(narrow.status).toBe(200);
    const nudgeCount = h.nudges.length;

    const res = await promoteFlagConfig(h, {
      fromEnvironmentId: ids.devEnvironmentId,
      select: { targeting: true },
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      code: "VARIANT_NOT_AVAILABLE",
      details: {
        flagId: ids.flagId,
        environmentId: ids.environmentId,
        missingVariants: ["treatment"],
        recommendedAction: "ADD_VARIANT_TO_ENV",
      },
    });
    expect(h.nudges).toHaveLength(nudgeCount);
  });
});
