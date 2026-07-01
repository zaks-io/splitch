import {
  CURRENT_KV_SCHEMA_VERSION,
  experimentConfigKey,
  flagConfigKey,
  runConfigKey,
} from "@splitch/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeConfigStore } from "./config-store.js";
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
  token,
} from "./config-store-test-harness.js";

let h: Harness;

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
      details: { requiredScopes: [`app:${ids.appId}:admin`] },
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
