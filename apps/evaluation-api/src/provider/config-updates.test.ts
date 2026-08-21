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

  it("pins the open socket with waitUntil until close", async () => {
    const socket = fakeSocket();
    const waitUntil = vi.fn();
    const updates = new DurableConfigUpdates({
      getByName: () => ({
        fetch: async () => upgradeResponse(socket),
        readFlagConfigForEvaluation: async () => snapshot(),
      }),
    });
    updates.setWaitUntil(waitUntil);
    const provider = new KvProvider(new FakeKv(), { configUpdates: updates });

    await provider.getFlag("app-A", "env-1", "f");

    expect(waitUntil).toHaveBeenCalledTimes(1);
    const lifetime = waitUntil.mock.calls[0]?.[0] as Promise<unknown>;
    expect(lifetime).toBeInstanceOf(Promise);
    const handlers = closeHandlers(socket);
    expect(handlers.length).toBeGreaterThan(0);
    for (const handler of handlers) handler();
    await expect(lifetime).resolves.toBeUndefined();
  });

  it("re-subscribes and drops the Environment cache once the pin outlives the waitUntil window", async () => {
    const harness = pinHarness();

    await expect(harness.provider.getFlag("app-A", "env-1", "f")).resolves.toMatchObject({
      enabled: true,
    });
    harness.invalidateEnvironment.mockClear();
    harness.toggleOff();
    harness.advance(25_000);

    await expect(harness.provider.getFlag("app-A", "env-1", "f")).resolves.toMatchObject({
      enabled: false,
    });
    expect(harness.fetch).toHaveBeenCalledTimes(2);
    expect(harness.waitUntil).toHaveBeenCalledTimes(2);
    expect(harness.invalidateEnvironment).toHaveBeenCalledWith("app-A", "env-1");
    expect(harness.readFlagConfigForEvaluation).toHaveBeenCalledTimes(2);
  });

  it("keeps serving the cache while the pin is still inside the waitUntil window", async () => {
    const harness = pinHarness();

    await harness.provider.getFlag("app-A", "env-1", "f");
    harness.invalidateEnvironment.mockClear();
    harness.toggleOff();
    harness.advance(24_999);

    await expect(harness.provider.getFlag("app-A", "env-1", "f")).resolves.toMatchObject({
      enabled: true,
    });
    expect(harness.fetch).toHaveBeenCalledTimes(1);
    expect(harness.invalidateEnvironment).not.toHaveBeenCalled();
    expect(harness.readFlagConfigForEvaluation).toHaveBeenCalledTimes(1);
  });

  it("serves the authoritative read and logs when the re-subscribe fails", async () => {
    const harness = pinHarness();

    await harness.provider.getFlag("app-A", "env-1", "f");
    harness.invalidateEnvironment.mockClear();
    harness.toggleOff();
    harness.refuseConnects(1);
    harness.advance(25_000);

    await expect(harness.provider.getFlag("app-A", "env-1", "f")).resolves.toMatchObject({
      enabled: false,
    });
    expect(harness.logger.error).toHaveBeenCalledWith(
      "evaluation_config_resubscribe_failed",
      expect.objectContaining({ appId: "app-A", environmentId: "env-1" }),
    );
    expect(harness.invalidateEnvironment).toHaveBeenCalledWith("app-A", "env-1");
  });

  it("keeps degrading gracefully for every request of a Config Store outage", async () => {
    const harness = pinHarness();

    await harness.provider.getFlag("app-A", "env-1", "f");
    harness.toggleOff();
    harness.refuseConnects(2);
    harness.advance(25_000);

    await expect(harness.provider.getFlag("app-A", "env-1", "f")).resolves.toMatchObject({
      enabled: false,
    });
    // The second request of the same outage must not start failing loud just
    // because the first one already cleared `connected`.
    await expect(harness.provider.getFlag("app-A", "env-1", "f")).resolves.toMatchObject({
      enabled: false,
    });
    expect(harness.logger.error).toHaveBeenCalledTimes(2);
    expect(harness.readFlagConfigForEvaluation).toHaveBeenCalledTimes(3);
  });

  it("ignores a close from the socket the re-subscribe replaced", async () => {
    const harness = pinHarness();

    await harness.provider.getFlag("app-A", "env-1", "f");
    harness.advance(25_000);
    await harness.provider.getFlag("app-A", "env-1", "f");
    expect(harness.fetch).toHaveBeenCalledTimes(2);
    harness.invalidateEnvironment.mockClear();

    // The 25s..30s overlap: the superseded socket finally closes.
    for (const handler of closeHandlers(harness.sockets[0])) handler();
    await harness.provider.getFlag("app-A", "env-1", "f");

    expect(harness.fetch).toHaveBeenCalledTimes(2);
    expect(harness.invalidateEnvironment).not.toHaveBeenCalled();
  });
});

/**
 * One warm isolate: a controllable clock, a Config Store that can change the
 * Flag between reads, and the KvProvider that caches it.
 */
function pinHarness() {
  let clock = 1_000;
  let enabled = true;
  let refusals = 0;
  const sockets: ReturnType<typeof fakeSocket>[] = [];
  const logger = { error: vi.fn() };
  const waitUntil = vi.fn();
  const fetch = vi.fn(async () => {
    if (refusals > 0) {
      refusals -= 1;
      return refusedResponse();
    }
    const socket = fakeSocket();
    sockets.push(socket);
    return upgradeResponse(socket);
  });
  const readFlagConfigForEvaluation = vi.fn(async () =>
    snapshot(flagConfigKV({ key: "f", enabled }), enabled ? 1 : 2),
  );
  const updates = new DurableConfigUpdates(
    { getByName: () => ({ fetch, readFlagConfigForEvaluation }) },
    logger,
    () => clock,
  );
  updates.setWaitUntil(waitUntil);
  const provider = new KvProvider(new FakeKv(), { configUpdates: updates });

  return {
    advance: (ms: number) => {
      clock += ms;
    },
    fetch,
    invalidateEnvironment: vi.spyOn(provider, "invalidateEnvironment"),
    logger,
    provider,
    readFlagConfigForEvaluation,
    refuseConnects: (count: number) => {
      refusals = count;
    },
    sockets,
    toggleOff: () => {
      enabled = false;
    },
    waitUntil,
  };
}

function snapshot(
  flag: FlagConfigKV = flagConfigKV({ key: "f" }),
  version = 1,
): EvaluationConfigSnapshot {
  return { flag, experiment: null, run: null, version };
}

function closeHandlers(socket: ReturnType<typeof fakeSocket> | undefined): (() => void)[] {
  if (socket === undefined) throw new Error("no socket was opened");
  return socket.addEventListener.mock.calls
    .filter(([event]) => event === "close")
    .map(([, handler]) => handler as () => void);
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
