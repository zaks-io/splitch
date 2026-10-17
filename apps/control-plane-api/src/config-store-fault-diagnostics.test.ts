import { inspect } from "node:util";
import { envScope, type Repository } from "@splitch/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type ConfigStoreDurableObjectNamespace,
  durableConfigStoreAccess,
} from "./config-store-access";
import { ConfigStoreDurableObject } from "./config-store-do";
import { catchConfigStoreFailure } from "./config-store-failure";
import { readFlagConfigOnMiss } from "./config-store-read-miss";
import { readFlagSnapshot } from "./config-store-shared";
import { buildSnapshotFromD1 } from "./config-store-snapshot-build";
import { DeletedFlagConfigSnapshotError } from "./config-store-snapshot-revision";
import type { ConfigStoreRuntimeDeps } from "./config-store-types";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    constructor(
      public ctx: unknown,
      public env: unknown,
    ) {}
  },
}));
vi.mock("./config-store-snapshot-build", () => ({ buildSnapshotFromD1: vi.fn() }));
vi.mock("./config-store", () => ({
  makeConfigStore: (deps: { broadcaster: { broadcast: (nudge: unknown) => void } }) => ({
    resyncFlagConfig: async () => deps.broadcaster.broadcast({ type: "config.changed" }),
  }),
}));

const CANARY = "qxZ7s3crt";
const input = { appId: "app_1", environmentId: "env_1", flagId: "flag_1" };
const scope = envScope(input.appId, input.environmentId);
const snapshot = {
  flag: { id: input.flagId, key: "checkout", environmentId: input.environmentId },
  version: 1,
};

afterEach(() => vi.restoreAllMocks());

function parseFailure(): Error {
  try {
    JSON.parse(`${CANARY}!`);
  } catch (error) {
    expect(error).toBeInstanceOf(SyntaxError);
    expect((error as Error).message).toContain(CANARY);
    return error as Error;
  }
  throw new Error("Invalid JSON unexpectedly parsed");
}

function assertSafe(calls: unknown) {
  const logged = inspect(calls, {
    showHidden: true,
    depth: null,
    maxStringLength: null,
    maxArrayLength: null,
  });
  expect(logged).not.toContain(CANARY);
  expect(logged).toContain("[message withheld]");
}

function logger() {
  return { error: vi.fn(), warn: vi.fn() };
}

describe("Config Store fault diagnostics", () => {
  it("withholds a native parse error from a failed snapshot read", async () => {
    const cause = parseFailure();
    const logs = logger();
    const access = durableConfigStoreAccess(
      {} as ConfigStoreDurableObjectNamespace,
      {
        get: vi.fn().mockRejectedValue(cause),
      } as unknown as KVNamespace,
      { logger: logs, writeThrough: new Map() },
    );

    await expect(access.readFlagConfig(input)).rejects.toBe(cause);

    expect(logs.error).toHaveBeenCalledWith("config_store_kv_read_failed", expect.any(Object));
    assertSafe([logs.error.mock.calls, logs.warn.mock.calls]);
  });

  it("withholds a native parse cause when background snapshot repair fails", async () => {
    vi.mocked(buildSnapshotFromD1).mockResolvedValue(snapshot as never);
    const logs = logger();
    const pending: Promise<unknown>[] = [];
    const repair = vi.fn().mockRejectedValue(new Error("repair failed", { cause: parseFailure() }));

    const result = await readFlagConfigOnMiss({
      input,
      key: "snapshot-key",
      scope,
      logger: logs,
      namespace: { getByName: () => ({ repairFlagConfigSnapshot: repair }) },
      remember: vi.fn(),
      repo: {} as Repository,
      waitUntil: (promise) => pending.push(promise),
    });
    await Promise.all(pending);

    expect(result.ok).toBe(true);
    expect(repair).toHaveBeenCalledOnce();
    expect(logs.error).toHaveBeenCalledWith(
      "config_store_kv_snapshot_repair_failed",
      expect.any(Object),
    );
    assertSafe([logs.error.mock.calls, logs.warn.mock.calls]);
  });

  it("withholds the native parse failure from a malformed Flag Configuration envelope", async () => {
    vi.mocked(buildSnapshotFromD1).mockResolvedValue(snapshot as never);
    const logs = logger();
    const deps = {
      repo: {},
      kv: { get: vi.fn().mockResolvedValue(`${CANARY}!`) },
      logger: logs,
    } as unknown as ConfigStoreRuntimeDeps;

    await expect(readFlagSnapshot(deps, scope, input.flagId)).rejects.toBeInstanceOf(SyntaxError);

    expect(logs.warn).toHaveBeenCalledWith("config_store_kv_schema_mismatch", expect.any(Object));
    assertSafe([logs.error.mock.calls, logs.warn.mock.calls]);
  });

  it("withholds native parse causes when a deleted snapshot write is refused", async () => {
    const logs = logger();
    const error = new DeletedFlagConfigSnapshotError(input.flagId);
    Object.defineProperty(error, "cause", { value: parseFailure() });

    await expect(
      catchConfigStoreFailure({ logger: logs } as ConfigStoreRuntimeDeps, async () => {
        throw error;
      }),
    ).resolves.toEqual({ ok: false, reason: "FLAG_NOT_FOUND" });

    expect(logs.error).toHaveBeenCalledWith(
      "config_store_deleted_snapshot_write_refused",
      expect.any(Object),
    );
    assertSafe([logs.error.mock.calls, logs.warn.mock.calls]);
  });

  it("withholds socket send failures and continues broadcasting to healthy sockets", async () => {
    const logs = vi.spyOn(console, "warn").mockImplementation(() => {});
    const healthySend = vi.fn();
    const object = new ConfigStoreDurableObject(
      {
        storage: {},
        getWebSockets: () => [
          {
            send: () => {
              throw new Error("socket send failed", { cause: parseFailure() });
            },
          },
          { send: healthySend },
        ],
      } as unknown as DurableObjectState,
      { DB: {} } as never,
    );

    await object.resyncFlagConfig(input);

    expect(healthySend).toHaveBeenCalledOnce();
    expect(logs).toHaveBeenCalledWith("config_store_live_update_send_failed", expect.any(Object));
    assertSafe(logs.mock.calls);
  });
});
