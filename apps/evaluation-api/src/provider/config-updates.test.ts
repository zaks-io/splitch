import type { FlagConfigKV } from "@splitch/contracts";
import { describe, expect, it, vi } from "vitest";
import { DurableConfigUpdates, type EvaluationConfigSnapshot } from "./config-updates";
import { FakeKv } from "./fake-kv";
import { flagConfigKV } from "./fixtures";
import { KvProvider } from "./kv-provider";

describe("DurableConfigUpdates", () => {
  it("shares one in-flight connect across concurrent Flag reads", async () => {
    const connection = deferred<Response>();
    const socket = fakeSocket();
    const fetch = vi.fn(() => connection.promise);
    const readFlagConfigForEvaluation = vi.fn(async () => snapshot());
    const updates = new DurableConfigUpdates({
      getByName: () => ({ fetch, readFlagConfigForEvaluation }),
    });
    const kv = new FakeKv();
    const provider = new KvProvider(kv, { configUpdates: updates });

    const reads = Array.from({ length: 8 }, () => provider.getFlag("app-A", "env-1", "f"));
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    connection.resolve(upgradeResponse(socket));

    await expect(Promise.all(reads)).resolves.toEqual(
      Array.from({ length: 8 }, () => expect.objectContaining({ flagKey: "f" })),
    );
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(socket.accept).toHaveBeenCalledTimes(1);
    expect(kv.getCalls).toHaveLength(0);
  });

  it("rejects loudly when the shared connect genuinely fails", async () => {
    const fetch = vi.fn(async () => refusedResponse());
    const updates = new DurableConfigUpdates({
      getByName: () => ({ fetch, readFlagConfigForEvaluation: async () => snapshot() }),
    });
    const provider = new KvProvider(new FakeKv(), { configUpdates: updates });

    const results = await Promise.allSettled(
      Array.from({ length: 4 }, () => provider.getFlag("app-A", "env-1", "f")),
    );

    expect(results).toEqual(
      Array.from({ length: 4 }, () => ({
        status: "rejected",
        reason: expect.objectContaining({
          errorCode: "SERVICE_UNAVAILABLE",
          resolutionReason: "ERROR",
        }),
      })),
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

function snapshot(flag: FlagConfigKV = flagConfigKV({ key: "f" })): EvaluationConfigSnapshot {
  return { flag, experiment: null, run: null, version: 1 };
}

function fakeSocket() {
  return {
    addEventListener: vi.fn(),
    accept: vi.fn(),
    close: vi.fn(),
  };
}

function upgradeResponse(socket: ReturnType<typeof fakeSocket>): Response {
  return { status: 101, webSocket: socket } as unknown as Response;
}

function refusedResponse(): Response {
  return { status: 503, webSocket: null } as unknown as Response;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}
