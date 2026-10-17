import { appScope, envScope } from "@splitch/db";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ids, NOW, temporaryEnvironmentHarness } from "./temporary-environment-test-harness";

let h: Awaited<ReturnType<typeof temporaryEnvironmentHarness>>;
beforeEach(async () => {
  h = await temporaryEnvironmentHarness();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await h.dispose();
});

async function createFlag() {
  const response = await h.request("/flags", "POST", {
    appId: ids.appId,
    key: "recovery",
    name: "Recovery",
    lifecycleClass: "ops",
    variants: [{ name: "off", value: false, isDefault: true }],
    idempotency_key: "recovery-flag",
  });
  expect(response.status).toBe(200);
  return response.json();
}

function failSyncFlag(flagId: string) {
  const writerFor = h.configStore.writerFor;
  return vi.spyOn(h.configStore, "writerFor").mockImplementation((appId, environmentId) => {
    const writer = writerFor(appId, environmentId);
    return {
      ...writer,
      syncFlagConfig: async (input) => {
        if (input.flagId === flagId) throw new Error("injected Sync failure");
        return writer.syncFlagConfig(input);
      },
    };
  });
}

it("returns bounded partial Sync evidence, preserves provenance, and completes on retry", async () => {
  const flag = await createFlag();
  const target = await (await h.create()).json();
  h.setTime("2026-07-01T20:00:01.000Z");
  const failure = failSyncFlag(flag.id);
  const response = await h.request(`/envs/${target.id}/sync`, "POST", {
    fromEnvironmentId: "production",
  });
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({
    code: "ENVIRONMENT_SYNC_INCOMPLETE",
    details: { applied: 1, failed: 1, failedFlagIds: [flag.id], retryAfterMs: 1000 },
  });
  const beforeRetry = await h.repo.identity.getEnvironment(appScope(ids.appId), target.id);
  expect(beforeRetry?.syncedAt).toBe(NOW);
  expect(beforeRetry?.syncedFromEnvironmentId).toBe(ids.devEnvironmentId);
  failure.mockRestore();
  const retry = await h.request(`/envs/${target.id}/sync`, "POST", {
    fromEnvironmentId: "production",
  });
  expect(retry.status).toBe(200);
  expect(await retry.json()).toMatchObject({
    syncedFlags: 2,
    temporary: { syncedFromEnvironmentId: ids.environmentId, syncedAt: h.nowIso() },
  });
});

it("rolls back a failed create copy through the full teardown cascade", async () => {
  failSyncFlag(ids.flagId);
  const response = await h.create("failed-copy");
  expect(response.status).toBe(503);
  expect((await response.json()).code).toBe("ENVIRONMENT_SYNC_INCOMPLETE");
  expect(await h.repo.identity.getEnvironmentByKey(appScope(ids.appId), "failed-copy")).toBeNull();
  expect(await h.repo.identity.countEnvironments(appScope(ids.appId))).toBe(2);
});

it("rolls back a failed Client Key provision instead of returning a partial create", async () => {
  vi.spyOn(h.repo.credentials.clientKeys, "insert").mockRejectedValueOnce(
    new Error("injected key failure"),
  );
  const response = await h.create("failed-key");
  expect(response.status).toBe(500);
  expect(await h.repo.identity.getEnvironmentByKey(appScope(ids.appId), "failed-key")).toBeNull();
  expect(await h.repo.identity.countEnvironments(appScope(ids.appId))).toBe(2);
});

it("counts only permanent Environments for the last-Environment guard", async () => {
  await h.create();
  await h.repo.identity.updateEnvironment(appScope(ids.appId), ids.environmentId, {
    expiresAt: "2026-07-02T20:00:00.000Z",
    syncedFromEnvironmentId: ids.devEnvironmentId,
    syncedAt: NOW,
  });
  const response = await h.request(`/envs/${ids.devEnvironmentId}`, "DELETE");
  expect(response.status).toBe(409);
  expect((await response.json()).code).toBe("LAST_ENVIRONMENT_REQUIRED");
});

it("deletes a Flag's configuration from an expired Temporary Environment", async () => {
  const flag = await createFlag();
  const target = await (await h.create()).json();
  const scope = envScope(ids.appId, target.id);
  expect(await h.repo.flags.getFlagConfig(scope, flag.id)).not.toBeNull();
  h.setTime(target.temporary.expiresAt);
  const response = await h.request(`/flags/${flag.id}`, "DELETE");
  expect({ status: response.status, faults: h.faults }).toEqual({ status: 200, faults: [] });
  expect(await h.repo.flags.getFlagConfig(scope, flag.id)).toBeNull();
  expect(await h.repo.flags.listTargetingRules(scope, flag.id)).toEqual([]);
});
