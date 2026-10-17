import type { Repository } from "@splitch/db";
import { beforeEach, expect, it, vi } from "vitest";
import { runEnvironmentMutation } from "./config-store-expiry-fence";
import { makeConfigStoreRuntimeDeps } from "./config-store-runtime";

const input = { appId: "app_runtime", environmentId: "env_runtime" };
const row = { ...input, id: input.environmentId, expiresAt: null };
const getEnvironment = vi.fn();
const put = vi.fn(async () => {});
const record = vi.fn(async () => {
  throw new Error("permanent writes must not journal");
});
const kv = { put, get: async () => null, delete: async () => {} } as unknown as KVNamespace;

beforeEach(() => vi.clearAllMocks());

function runtime() {
  return makeConfigStoreRuntimeDeps({
    repo: { identity: { getEnvironment } } as unknown as Repository,
    kv,
    projectionJournal: { record, list: async () => [] },
    broadcaster: { broadcast() {} },
    nextSnapshotRevision: () => 1,
  });
}

it("blocks unclassified publication while allowing reads and removals", async () => {
  const deps = runtime();
  await expect(deps.kv.put("unknown", "snapshot")).rejects.toThrow("Environment kind");
  expect(await deps.kv.get("unknown")).toBeNull();
  await deps.kv.delete("unknown");
  expect(put).not.toHaveBeenCalled();
  expect(record).not.toHaveBeenCalled();
});

it("selects the original permanent KV adapter without per-put journal calls or D1 queries", async () => {
  getEnvironment.mockResolvedValue(row);
  const deps = runtime();
  await runEnvironmentMutation(deps, input, async () => {
    expect(deps.kv).toBe(kv);
    await deps.kv.put("first", "snapshot");
    await deps.kv.put("second", "snapshot");
    await deps.kv.put("third", "snapshot");
  });
  expect(getEnvironment).toHaveBeenCalledOnce();
  expect(put).toHaveBeenCalledTimes(3);
  expect(record).not.toHaveBeenCalled();
});

it.each(["missing", "unreadable", "invalid expiry"])(
  "blocks publication after a %s D1 row instead of reusing the permanent adapter",
  async (failure) => {
    getEnvironment.mockResolvedValueOnce(row);
    const deps = runtime();
    await runEnvironmentMutation(deps, input, async () => {});
    expect(deps.kv).toBe(kv);
    const operation = vi.fn(() => deps.kv.put("refused", "snapshot"));
    if (failure === "unreadable") getEnvironment.mockRejectedValueOnce(new Error("D1 unavailable"));
    else
      getEnvironment.mockResolvedValueOnce(
        failure === "missing" ? null : { ...row, expiresAt: "invalid" },
      );

    const result = runEnvironmentMutation(deps, input, operation);
    if (failure === "missing")
      await expect(result).resolves.toEqual({ ok: false, reason: "ENVIRONMENT_NOT_FOUND" });
    else
      await expect(result).rejects.toThrow(
        failure === "unreadable" ? "D1 unavailable" : "invalid Environment expiry",
      );
    await expect(deps.kv.put("refused", "snapshot")).rejects.toThrow("Environment kind");
    expect(operation).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  },
);
