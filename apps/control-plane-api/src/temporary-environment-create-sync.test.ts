import { appScope, envScope } from "@splitch/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ALLOW_POLICY } from "./app-environment-model";
import { environmentCreateConflict } from "./environment-create-conflict";
import { ids, NOW, temporaryEnvironmentHarness } from "./temporary-environment-test-harness";

let h: Awaited<ReturnType<typeof temporaryEnvironmentHarness>>;
beforeEach(async () => {
  h = await temporaryEnvironmentHarness();
});
afterEach(async () => {
  await h.dispose();
});

describe("Temporary Environment create and Sync", () => {
  it("creates a whole copy and public Client Key, then Sync replaces local edits", async () => {
    const response = await h.create();
    expect(response.status).toBe(200);
    const created = await response.json();
    expect(created.temporary).toEqual({
      expiresAt: "2026-07-08T20:00:00.000Z",
      syncedFromEnvironmentId: ids.devEnvironmentId,
      syncedAt: NOW,
    });
    expect(created.policy).toEqual(ALLOW_POLICY);
    expect(typeof created.clientKey.keyMaterial).toBe("string");
    expect((await h.config(created.id))?.enabled).toBe(true);
    const rules = await h.repo.flags.listTargetingRules(
      envScope(ids.appId, created.id),
      ids.flagId,
    );
    expect(rules).toHaveLength(1);
    const rollout = rules[0]?.percentageRollout;
    if (!rollout) throw new Error("Expected copied percentage rollout");
    expect(JSON.parse(rollout)).toEqual({
      percentage: 25,
      salt: "dev-rollout",
    });
    const toggled = await h.request(`/envs/${created.id}/flags/${ids.flagId}/config`, "PATCH", {
      enabled: false,
      idempotency_key: "temporary-toggle",
    });
    expect({ status: toggled.status, body: await toggled.json() }).toMatchObject({ status: 200 });
    expect((await h.config(ids.devEnvironmentId))?.enabled).toBe(true);
    const synced = await h.request(`/envs/${created.id}/sync`, "POST", {
      fromEnvironmentId: "dev",
    });
    expect(synced.status).toBe(200);
    expect((await synced.json()).syncedFlags).toBe(1);
    expect((await h.config(created.id))?.enabled).toBe(true);
    expect(
      (await h.request(`/envs/${created.id}/sync`, "POST", { fromEnvironmentId: "dev" })).status,
    ).toBe(200);
  });

  it.each(["2026-07-01T20:01:00.000Z", "2026-07-08T20:00:00.001Z"])(
    "refuses out-of-bounds expiry %s before creation",
    async (expiresAt) => {
      expect((await h.create("bad-expiry", { fromEnvironmentId: "dev", expiresAt })).status).toBe(
        400,
      );
      expect(
        await h.repo.identity.getEnvironmentByKey(appScope(ids.appId), "bad-expiry"),
      ).toBeNull();
    },
  );

  it("refuses Policy, permanent Sync, self Sync and unknown or foreign sources", async () => {
    expect(
      (await (await h.create("policy", undefined, { policy: ALLOW_POLICY })).json()).code,
    ).toBe("ENVIRONMENT_KIND_UNSUPPORTED");
    expect(
      (
        await (
          await h.request(`/envs/${ids.devEnvironmentId}/sync`, "POST", {
            fromEnvironmentId: "production",
          })
        ).json()
      ).code,
    ).toBe("ENVIRONMENT_KIND_UNSUPPORTED");
    const created = await (await h.create()).json();
    expect(
      (await h.request(`/envs/${created.id}/sync`, "POST", { fromEnvironmentId: created.id }))
        .status,
    ).toBe(400);
    expect(
      (await (await h.request(`/envs/${created.id}`, "PATCH", { policy: ALLOW_POLICY })).json())
        .code,
    ).toBe("ENVIRONMENT_KIND_UNSUPPORTED");
    await h.repo.identity.environments.insert(appScope(ids.otherAppId), {
      id: "env_foreign",
      appId: ids.otherAppId,
      key: "foreign",
      name: "Foreign",
      createdAt: NOW,
      updatedAt: NOW,
    });
    for (const fromEnvironmentId of ["unknown", "env_foreign"]) {
      expect((await (await h.create("bad-source", { fromEnvironmentId })).json()).code).toBe(
        "ENVIRONMENT_NOT_FOUND",
      );
    }
  });

  it.each([false, true])(
    "maps duplicate Environment keys to SLUG_CONFLICT for temporary=%s",
    async (temporary) => {
      const response = await h.request("/envs", "POST", {
        key: "dev",
        ...(temporary ? { temporary: { fromEnvironmentId: "production" } } : {}),
      });
      expect(response.status).toBe(409);
      expect((await response.json()).details).toEqual({
        resourceType: "environment",
        conflictingSlug: "dev",
        recommendedAction: "CHOOSE_DIFFERENT_SLUG",
      });
    },
  );

  it("keeps an expired Environment's key reserved until teardown", async () => {
    const created = await (await h.create()).json();
    h.setTime(created.temporary.expiresAt);
    const response = await h.create();
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe("SLUG_CONFLICT");
    expect((await h.request(`/envs/${created.id}`, "DELETE")).status).toBe(200);
    expect((await h.create()).status).toBe(200);
  });

  it("propagates unrelated D1 failures", () => {
    const failure = new Error("UNIQUE constraint failed: environments.id");
    expect(() => environmentCreateConflict(failure, "dev", "request")).toThrow(failure);
  });

  it("preflights 501 Flags for both create and Sync without writing", async () => {
    const created = await (await h.create()).json();
    const before = await h.config(created.id);
    await h.d1
      .prepare(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x + 1 FROM n WHERE x < 500)
      INSERT INTO flags(id, app_id, key, name, created_at, updated_at)
      SELECT 'flag_limit_' || x, ?, 'limit-' || x, 'Limit', ?, ? FROM n`)
      .bind(ids.appId, NOW, NOW)
      .run();
    const refused = await h.create("too-large");
    expect((await refused.json()).code).toBe("SYNC_LIMIT_EXCEEDED");
    expect(await h.repo.identity.getEnvironmentByKey(appScope(ids.appId), "too-large")).toBeNull();
    expect(
      (
        await (
          await h.request(`/envs/${created.id}/sync`, "POST", { fromEnvironmentId: "production" })
        ).json()
      ).code,
    ).toBe("SYNC_LIMIT_EXCEEDED");
    expect(await h.config(created.id)).toEqual(before);
  });
});
