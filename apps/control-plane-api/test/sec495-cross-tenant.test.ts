import { controlPlaneFlagConfigKey } from "@splitch/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  get,
  makeWorld,
  securityKv,
  seedSecondEnvironment,
  setupSecurityFixture,
  teardownSecurityFixture,
  writeSnapshots,
  writeSnapshotsIn,
} from "./sec495-cross-tenant-fixture";
import { ALPHA, BRAVO } from "./sec495-cross-tenant-seed";

beforeEach(setupSecurityFixture);
afterEach(teardownSecurityFixture);

describe("SPL-526 warm KV read tenant isolation", () => {
  it("H1: alpha's token cannot address bravo's App", async () => {
    const world = makeWorld();
    await writeSnapshots(world, ALPHA);
    await writeSnapshots(world, BRAVO);

    const response = await get(world.app, ALPHA, BRAVO.appId, BRAVO.envId, BRAVO.flagId);
    const body = await response.text();

    expect(response.status).toBe(403);
    expect(body).toContain("FORBIDDEN");
    expect(body).not.toContain(BRAVO.ruleValue);
    expect(body).not.toContain(BRAVO.flagId);
  });

  it("H2: alpha's App plus bravo's Environment and Flag never reads bravo", async () => {
    const kv = securityKv();
    const world = makeWorld();
    await writeSnapshots(world, ALPHA);
    await writeSnapshots(world, BRAVO);
    const crossKey = controlPlaneFlagConfigKey(ALPHA.appId, BRAVO.envId, BRAVO.flagId);

    const response = await get(world.app, ALPHA, ALPHA.appId, BRAVO.envId, BRAVO.flagId);
    const body = await response.text();

    expect(response.status).toBe(404);
    expect(body).not.toContain(BRAVO.ruleValue);
    expect(await kv.get(crossKey, "text")).toBeNull();
    expect(
      await kv.get(controlPlaneFlagConfigKey(BRAVO.appId, BRAVO.envId, BRAVO.flagId), "text"),
    ).toContain(BRAVO.ruleValue);
  });

  it("H3: separator injection cannot spell another snapshot key", async () => {
    const world = makeWorld();
    await writeSnapshots(world, ALPHA);
    await writeSnapshots(world, BRAVO);

    const injectedEnvironment = await get(
      world.app,
      ALPHA,
      ALPHA.appId,
      `${ALPHA.envId}:control-plane-flag-config:${ALPHA.flagId}`,
      "anything",
    );
    expect(injectedEnvironment.status).toBe(404);
    const injectedFlag = await get(
      world.app,
      ALPHA,
      ALPHA.appId,
      ALPHA.envId,
      `${ALPHA.flagId}:control-plane-flag-config:${BRAVO.flagId}`,
    );
    expect(injectedFlag.status).toBe(404);
    const evaluationKeyProbe = await get(
      world.app,
      ALPHA,
      ALPHA.appId,
      `${ALPHA.envId}:flag`,
      ALPHA.flagKey,
    );
    expect(evaluationKeyProbe.status).toBe(404);
    expect(await evaluationKeyProbe.text()).not.toContain(ALPHA.treatmentVariantName);
  });

  it("H4: repair routes to the requested scope's Durable Object", async () => {
    const kv = securityKv();
    const writer = makeWorld();
    await writeSnapshots(writer, ALPHA);
    await writeSnapshots(writer, BRAVO);
    await kv.delete(controlPlaneFlagConfigKey(ALPHA.appId, ALPHA.envId, ALPHA.flagId));
    const world = makeWorld();

    const response = await get(world.app, ALPHA, ALPHA.appId, ALPHA.envId, ALPHA.flagId);

    expect(response.status).toBe(200);
    expect(world.names).toEqual([`${ALPHA.appId}:${ALPHA.envId}`]);
    expect(await response.text()).not.toContain(BRAVO.ruleValue);
  });

  it("H5: the isolate write-through map does not bleed between tenants", async () => {
    const world = makeWorld({ sharedWriteThrough: true });
    await writeSnapshots(world, ALPHA);
    await writeSnapshots(world, BRAVO);
    await world.access.writerFor(ALPHA.appId, ALPHA.envId).writeFlagConfig({
      appId: ALPHA.appId,
      environmentId: ALPHA.envId,
      flagId: ALPHA.flagId,
      enabled: true,
      actor: { ref: ALPHA.userId, via: "api" },
    });

    const response = await get(world.app, BRAVO, BRAVO.appId, BRAVO.envId, BRAVO.flagId);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ flagId: BRAVO.flagId, environmentId: BRAVO.envId });
    expect(JSON.stringify(body)).not.toContain(ALPHA.ruleValue);
    expect(JSON.stringify(body)).not.toContain(ALPHA.flagId);
  });
});

describe("SPL-526 warm KV read tenant isolation failure paths", () => {
  it("H6: alpha cannot tombstone bravo's Flag", async () => {
    const kv = securityKv();
    const world = makeWorld();
    await writeSnapshots(world, ALPHA);
    await writeSnapshots(world, BRAVO);
    const bravoKey = controlPlaneFlagConfigKey(BRAVO.appId, BRAVO.envId, BRAVO.flagId);
    const before = await kv.get(bravoKey, "text");

    const result = await world.access.writerFor(ALPHA.appId, ALPHA.envId).deleteFlagConfig({
      appId: ALPHA.appId,
      environmentId: ALPHA.envId,
      experimentIds: [],
      flagId: BRAVO.flagId,
    });

    expect(result).toMatchObject({ ok: false, reason: "FLAG_NOT_FOUND" });
    expect(await kv.get(bravoKey, "text")).toBe(before);
    expect((await get(world.app, BRAVO, BRAVO.appId, BRAVO.envId, BRAVO.flagId)).status).toBe(200);
  });

  it("H7: rejects a foreign-scope payload planted under alpha's key", async () => {
    const kv = securityKv();
    const error = vi.fn();
    const world = makeWorld({ error });
    await writeSnapshots(world, ALPHA);
    await writeSnapshots(world, BRAVO);
    const alphaKey = controlPlaneFlagConfigKey(ALPHA.appId, ALPHA.envId, ALPHA.flagId);
    const bravoKey = controlPlaneFlagConfigKey(BRAVO.appId, BRAVO.envId, BRAVO.flagId);
    const bravoSnapshot = await kv.get(bravoKey, "text");
    if (!bravoSnapshot) throw new Error("security fixture Bravo snapshot is missing");
    await kv.put(alphaKey, bravoSnapshot);
    world.names.length = 0;

    const response = await get(world.app, ALPHA, ALPHA.appId, ALPHA.envId, ALPHA.flagId);
    const body = await response.text();

    expect(response.status).toBe(500);
    expect(body).not.toContain(BRAVO.ruleValue);
    expect(body).not.toContain(BRAVO.flagId);
    expect(body).not.toContain(BRAVO.envId);
    expect(world.names).toEqual([]);
    expect(error).toHaveBeenCalledWith(
      "config_store_kv_snapshot_scope_mismatch",
      expect.objectContaining({
        appId: ALPHA.appId,
        environmentId: ALPHA.envId,
        flagId: ALPHA.flagId,
        mismatchAxes: expect.arrayContaining(["appId", "environmentId", "flagId"]),
      }),
    );
  });

  it("H8: the miss event contains no foreign identifiers", async () => {
    const kv = securityKv();
    const warn = vi.fn();
    const world = makeWorld({ warn });
    await writeSnapshots(world, ALPHA);
    await writeSnapshots(world, BRAVO);
    await kv.delete(controlPlaneFlagConfigKey(ALPHA.appId, ALPHA.envId, ALPHA.flagId));

    await get(world.app, ALPHA, ALPHA.appId, ALPHA.envId, ALPHA.flagId);

    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).not.toContain(BRAVO.appId);
    expect(logged).not.toContain(BRAVO.flagId);
    expect(logged).not.toContain(BRAVO.envId);
  });

  it("H9: the Environment axis separates two valid snapshots for one Flag", async () => {
    await seedSecondEnvironment(ALPHA);
    const world = makeWorld();
    await writeSnapshots(world, ALPHA);
    await writeSnapshotsIn(world, ALPHA, `${ALPHA.envId}_dev`);

    const prod = await get(world.app, ALPHA, ALPHA.appId, ALPHA.envId, ALPHA.flagId);
    const dev = await get(world.app, ALPHA, ALPHA.appId, `${ALPHA.envId}_dev`, ALPHA.flagId);

    expect(prod.status).toBe(200);
    expect(dev.status).toBe(200);
    expect(await prod.json()).toMatchObject({ environmentId: ALPHA.envId, enabled: false });
    expect(await dev.json()).toMatchObject({
      environmentId: `${ALPHA.envId}_dev`,
      enabled: true,
      availableVariantNames: [ALPHA.controlVariantName],
    });
  });
});
