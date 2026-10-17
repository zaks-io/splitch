import { getRoute } from "@splitch/contracts";
import { appScope } from "@splitch/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initializeFlagConfigsForFlag } from "./flag-config-lifecycle";
import { resyncFlagSnapshots } from "./flag-definition-handler-utils";
import { makePathSelectorResolver } from "./path-selector-resolution";
import { republishFlagConfigurations } from "./segment-republication";
import { ids, NOW, temporaryEnvironmentHarness } from "./temporary-environment-test-harness";

let h: Awaited<ReturnType<typeof temporaryEnvironmentHarness>>;
beforeEach(async () => {
  h = await temporaryEnvironmentHarness();
});
afterEach(async () => {
  await h.dispose();
});

describe("Temporary Environment safeguards", () => {
  it("enforces the atomic live limit and stops counting expired rows", async () => {
    await h.d1
      .prepare(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x + 1 FROM n WHERE x < 50)
      INSERT INTO environments(id, app_id, key, name, expires_at, synced_from_environment_id, synced_at, created_at, updated_at)
      SELECT 'env_limit_' || x, ?, 'limit-' || x, 'Limit', ?, ?, ?, ?, ? FROM n`)
      .bind(ids.appId, "2026-07-02T20:00:00.000Z", ids.devEnvironmentId, NOW, NOW, NOW)
      .run();
    const response = await h.create();
    expect(response.status).toBe(409);
    expect((await response.json()).details).toMatchObject({
      limit: 50,
      active: 50,
      nextExpiresAt: "2026-07-02T20:00:00.000Z",
    });
    h.setTime("2026-07-02T20:00:00.000Z");
    expect((await h.create()).status).toBe(200);
  });

  it("keeps read-only POSTs readable and refuses provisioning GET by contract effects", async () => {
    const created = await (await h.create()).json();
    h.setTime(created.temporary.expiresAt);
    const resolver = makePathSelectorResolver(h.repo, h.nowIso);
    const principal = {
      kind: "control-plane-token" as const,
      id: "user_temporary",
      appId: ids.appId,
      orgId: ids.orgId,
      environmentId: null,
      scopes: [`app:${ids.appId}:owner`],
      authDoor: "device_flow" as const,
    };
    for (const operation of ["flags_test_eval", "experiment_results_post", "client_key_get"]) {
      const contract = getRoute(operation);
      if (!contract) throw new Error(`Missing route ${operation}`);
      const params = {
        appId: ids.appId,
        environmentId: created.id,
        flagId: ids.flagId,
        experimentId: ids.experimentId,
      };
      const result = await resolver({
        contract,
        input: { params },
        params,
        principal,
        request: new Request(`https://test/apps/${ids.appId}/envs/${created.id}`, {
          method: contract.method,
        }),
        requestId: "read-only-test",
      });
      expect(result.ok).toBe(operation !== "client_key_get");
      if (!result.ok) expect(result.error.code).toBe("ENVIRONMENT_EXPIRED");
    }
    expect((await h.request(`/envs/${created.id}`)).status).toBe(200);
    expect((await (await h.request(`/envs/${created.id}/client-key`)).json()).code).toBe(
      "ENVIRONMENT_EXPIRED",
    );
    expect(
      (await (await h.request(`/envs/${created.id}`, "PATCH", { name: "Expired" })).json()).code,
    ).toBe("ENVIRONMENT_EXPIRED");
  });

  it("skips expired provisioning, Segment and Variant republication including an enumeration race", async () => {
    const created = await (await h.create()).json();
    h.setTime(created.temporary.expiresAt);
    await initializeFlagConfigsForFlag(h, {
      appId: ids.appId,
      flagId: ids.flagId,
      defaultVariantId: ids.controlVariantId,
    });
    await resyncFlagSnapshots(h, ids.appId, ids.flagId);
    const dependencies = {
      experimentDrafts: [],
      flagConfigurations: [
        {
          flagConfigurationId: "temp",
          flagId: ids.flagId,
          flagKey: ids.flagKey,
          flagName: "Checkout",
          environmentId: created.id,
          environmentKey: created.key,
          environmentName: created.name,
          targetingRuleIds: [],
        },
      ],
    };
    expect(await republishFlagConfigurations(h, ids.appId, dependencies)).toBeNull();
    const earlier = { ...h, nowIso: () => NOW };
    // Enumeration sees a live row, while the real writer checks the advanced clock.
    expect(await republishFlagConfigurations(earlier, ids.appId, dependencies)).toBeNull();
    await initializeFlagConfigsForFlag(earlier, {
      appId: ids.appId,
      flagId: ids.flagId,
      defaultVariantId: ids.controlVariantId,
    });
  });

  it("retains kind in audit history and never dispatches Temporary Environment changes after teardown", async () => {
    const created = await (await h.create()).json();
    const toggled = await h.writerFor(ids.appId, created.id).writeFlagConfig({
      actor: { ref: "user_temporary", via: "control-plane-token" },
      appId: ids.appId,
      environmentId: created.id,
      flagId: ids.flagId,
      enabled: false,
    });
    expect(toggled.ok).toBe(true);
    const log = await h.d1
      .prepare("SELECT temporary_environment FROM flag_change_events WHERE environment_id = ?")
      .bind(created.id)
      .all<{ temporary_environment: number }>();
    expect(log.results.length).toBeGreaterThan(0);
    expect(log.results.every((row) => row.temporary_environment === 1)).toBe(true);
    expect((await h.request(`/envs/${created.id}`, "DELETE")).status).toBe(200);
    const pending = await h.repo.flagChangeEvents.pendingForOrg(ids.orgId, 0, 1000);
    expect(pending.length).toBeGreaterThan(0);
    expect(pending.some((row) => row.environmentId === created.id)).toBe(false);
    const history = await h.repo.flagChangeEvents.listForApp(appScope(ids.appId), {
      includeAppLevel: false,
      environmentIds: [created.id],
      order: "asc",
      limit: 100,
    });
    expect(history.length).toBeGreaterThan(0);
  });

  it("ignores 50 Temporary Environments when planning 200 permanent Environments", async () => {
    await h.d1
      .prepare(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x + 1 FROM n WHERE x < 198)
      INSERT INTO environments(id, app_id, key, name, created_at, updated_at)
      SELECT 'env_permanent_' || x, ?, 'permanent-' || x, 'Permanent', ?, ? FROM n`)
      .bind(ids.appId, NOW, NOW)
      .run();
    const baseline = await h.request("/attention-rollup");
    expect(baseline.status).toBe(200);
    const expected = await baseline.json();
    await h.d1
      .prepare(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x + 1 FROM n WHERE x < 50)
      INSERT INTO environments(id, app_id, key, name, expires_at, synced_from_environment_id, synced_at, created_at, updated_at)
      SELECT 'env_temp_attention_' || x, ?, 'temp-' || x, 'Temporary', ?, ?, ?, ?, ? FROM n`)
      .bind(ids.appId, "2026-07-02T20:00:00.000Z", ids.devEnvironmentId, NOW, NOW, NOW)
      .run();
    const response = await h.request("/attention-rollup");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(expected);
    expect(expected.items).toHaveLength(200);
    expect(await h.repo.identity.countEnvironments(appScope(ids.appId))).toBe(250);
  }, 30_000);
});
