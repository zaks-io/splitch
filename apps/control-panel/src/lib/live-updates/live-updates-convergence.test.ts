import type { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleNudge, LiveUpdateConnection } from "#lib/live-updates/live-updates";

type FakeSocket = {
  close: () => void;
  onclose: ((event: CloseEvent) => unknown) | null;
  onerror: ((event: Event) => unknown) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onopen: ((event: Event) => unknown) | null;
};

const scope = { appId: "app_1", environmentId: "env_dev" };

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("nudge convergence", () => {
  it("jitters failed refetches through the Workers KV convergence window", async () => {
    vi.useFakeTimers();
    const attempts: number[] = [];
    const queryClient = queryClientStub();
    const startedAt = Date.now();
    queryClient.invalidateQueries.mockImplementation(() => {
      attempts.push(Date.now());
      return Promise.reject(new Error("read API unavailable"));
    });

    const pending = handleNudge(message("flag_1", 1).data, scope, queryClient.client, {
      random: () => 0,
    });
    await vi.advanceTimersByTimeAsync(49_600);
    await pending;

    expect(attempts.map((at) => at - startedAt)).toEqual([0, 1_600, 4_800, 11_200, 24_000, 49_600]);
  });

  it("keeps stale asserted until the refetched version reaches the nudge", async () => {
    vi.useFakeTimers();
    let version = 5;
    let attempts = 0;
    const queryClient = queryClientStub();
    queryClient.getQueryData.mockImplementation(() => ({ version }));
    queryClient.invalidateQueries.mockImplementation(() => {
      attempts += 1;
      if (attempts === 6) version = 6;
      return Promise.resolve();
    });
    const onFreshData = vi.fn();
    const onStaleData = vi.fn();

    const pending = handleNudge(message("flag_1", 6).data, scope, queryClient.client, {
      onFreshData,
      onStaleData,
      random: () => 0.5,
    });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(onStaleData).toHaveBeenCalledTimes(5);
    expect(onFreshData).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(32_000);
    await pending;
    expect(attempts).toBe(6);
    expect(onFreshData).toHaveBeenCalledOnce();
  });

  it("leaves stale asserted when the version never converges", async () => {
    vi.useFakeTimers();
    const queryClient = queryClientStub({ version: 5 });
    const onFreshData = vi.fn();
    const onStaleData = vi.fn();

    const pending = handleNudge(message("flag_1", 6).data, scope, queryClient.client, {
      onFreshData,
      onStaleData,
      random: () => 0.5,
    });
    await vi.advanceTimersByTimeAsync(62_000);
    await pending;

    expect(queryClient.invalidateQueries).toHaveBeenCalledTimes(6);
    expect(onStaleData).toHaveBeenCalledTimes(5);
    expect(onFreshData).not.toHaveBeenCalled();
  });
});

describe("deletion nudge convergence coordination", () => {
  it("clears a deletion target after its retry converges", async () => {
    vi.useFakeTimers();
    const { connection, queryClient, sockets, stale } = connectionHarness();
    connection.start();
    await vi.advanceTimersByTimeAsync(0);
    queryClient.invalidateQueries.mockClear();
    queryClient.invalidateQueries
      .mockRejectedValueOnce(new Error("read API unavailable"))
      .mockResolvedValue();

    socketAt(sockets, 0).onmessage?.(deletedMessage("flag_1"));
    await vi.advanceTimersByTimeAsync(0);
    expect(stale).toHaveBeenLastCalledWith(true);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(queryClient.invalidateQueries).toHaveBeenCalledTimes(2);
    expect(stale).toHaveBeenLastCalledWith(false);
  });
});

describe("nudge convergence coordination", () => {
  it("clears a stale target after a later delete nudge converges", async () => {
    vi.useFakeTimers();
    const { connection, queryClient, sockets, stale } = connectionHarness();
    connection.start();
    await vi.advanceTimersByTimeAsync(0);
    queryClient.invalidateQueries.mockRejectedValue(new Error("read API unavailable"));

    socketAt(sockets, 0).onmessage?.(deletedMessage("flag_1"));
    await vi.advanceTimersByTimeAsync(0);
    expect(stale).toHaveBeenLastCalledWith(true);

    queryClient.invalidateQueries.mockResolvedValue();
    socketAt(sockets, 0).onmessage?.(deletedMessage("flag_1"));
    await vi.advanceTimersByTimeAsync(0);
    expect(stale).toHaveBeenLastCalledWith(false);
  });

  it("cancels a pending nudge backoff when the connection stops", async () => {
    vi.useFakeTimers();
    const { connection, queryClient, sockets } = connectionHarness();
    connection.start();
    await vi.advanceTimersByTimeAsync(0);
    queryClient.invalidateQueries.mockRejectedValue(new Error("read API unavailable"));

    socketAt(sockets, 0).onmessage?.(deletedMessage("flag_1"));
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(1);

    connection.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not let an older nudge clear a newer nudge's stale state", async () => {
    vi.useFakeTimers();
    const { connection, queryClient, sockets, stale } = connectionHarness();
    let version = 5;
    queryClient.getQueryData.mockImplementation(() => ({ version }));
    connection.start();
    await vi.advanceTimersByTimeAsync(0);

    const olderRefetch = deferred<void>();
    let nudgeRefetches = 0;
    queryClient.invalidateQueries.mockImplementation(() => {
      nudgeRefetches += 1;
      if (nudgeRefetches === 1) return olderRefetch.promise;
      if (nudgeRefetches === 3) version = 7;
      return Promise.resolve();
    });
    socketAt(sockets, 0).onmessage?.(message("flag_1", 6));
    socketAt(sockets, 0).onmessage?.(message("flag_1", 7));
    await vi.advanceTimersByTimeAsync(0);

    expect(stale).toHaveBeenLastCalledWith(true);
    version = 6;
    olderRefetch.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(stale).not.toHaveBeenCalledWith(false);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(stale).toHaveBeenLastCalledWith(false);
  });

  it("keeps independent targets stale until all have converged", async () => {
    vi.useFakeTimers();
    const { connection, queryClient, sockets, stale } = connectionHarness();
    let flagVersion = 5;
    let segmentVersion = 2;
    queryClient.getQueryData.mockImplementation((key?: readonly unknown[]) =>
      key?.includes("flag_1") ? { version: flagVersion } : { version: segmentVersion },
    );
    connection.start();
    await vi.advanceTimersByTimeAsync(0);

    socketAt(sockets, 0).onmessage?.(message("flag_1", 6));
    socketAt(sockets, 0).onmessage?.(entityMessage("segment", "segment_1", 3));
    await vi.advanceTimersByTimeAsync(0);
    expect(stale).toHaveBeenLastCalledWith(true);

    flagVersion = 6;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(stale).toHaveBeenLastCalledWith(true);

    segmentVersion = 3;
    await vi.advanceTimersByTimeAsync(4_000);
    expect(stale).toHaveBeenLastCalledWith(false);
  });

  it("clears a stale target when its replacement nudge is already fresh", async () => {
    vi.useFakeTimers();
    const { connection, queryClient, sockets, stale } = connectionHarness();
    let version = 5;
    queryClient.getQueryData.mockImplementation(() => ({ version }));
    connection.start();
    await vi.advanceTimersByTimeAsync(0);

    socketAt(sockets, 0).onmessage?.(message("flag_1", 6));
    await vi.advanceTimersByTimeAsync(0);
    expect(stale).toHaveBeenLastCalledWith(true);

    version = 6;
    socketAt(sockets, 0).onmessage?.(message("flag_1", 6));
    await vi.advanceTimersByTimeAsync(0);
    expect(stale).toHaveBeenLastCalledWith(false);

    await vi.advanceTimersByTimeAsync(62_000);
    expect(stale).toHaveBeenLastCalledWith(false);
  });

  it("stops invalidating when the owning connection is cancelled", async () => {
    vi.useFakeTimers();
    const refetchRoute = vi.fn(() => Promise.resolve());
    const { connection, queryClient, sockets } = connectionHarness({ refetchRoute });
    connection.start();
    await vi.advanceTimersByTimeAsync(0);
    queryClient.invalidateQueries.mockClear();
    refetchRoute.mockClear();
    queryClient.getQueryData.mockReturnValue({ version: 1 });
    const firstInvalidation = deferred<void>();
    let nudgeInvalidations = 0;
    queryClient.invalidateQueries.mockImplementation((filters) => {
      if (filters && "refetchType" in filters) {
        nudgeInvalidations += 1;
        if (nudgeInvalidations === 1) return firstInvalidation.promise;
      }
      return Promise.resolve();
    });

    socketAt(sockets, 0).onmessage?.(message("flag_1", 2));
    await vi.advanceTimersByTimeAsync(0);
    expect(nudgeInvalidations).toBe(1);
    connection.stop();
    firstInvalidation.resolve();
    await vi.advanceTimersByTimeAsync(62_000);

    expect(nudgeInvalidations).toBe(1);
    expect(refetchRoute).not.toHaveBeenCalled();
  });
});

function connectionHarness(options: { refetchRoute?: () => Promise<void> } = {}) {
  const sockets: FakeSocket[] = [];
  const stale = vi.fn();
  const queryClient = queryClientStub();
  const connection = new LiveUpdateConnection({
    createSocket: () => {
      const socket = fakeSocket();
      sockets.push(socket);
      return socket;
    },
    onStaleDataChange: stale,
    queryClient: queryClient.client,
    random: () => 0.5,
    refetchRoute: options.refetchRoute,
    scope,
    url: "ws://panel.test/acme/app/dev/live",
  });
  return { connection, queryClient, sockets, stale };
}

function fakeSocket(): FakeSocket {
  return {
    close: vi.fn(),
    onclose: null,
    onerror: null,
    onmessage: null,
    onopen: null,
  };
}

function socketAt(sockets: FakeSocket[], index: number): FakeSocket {
  const socket = sockets[index];
  if (!socket) throw new Error(`Socket ${index} was not created`);
  return socket;
}

function message(id: string, version: number): MessageEvent {
  return entityMessage("flag", id, version);
}

function deletedMessage(id: string): MessageEvent {
  return {
    data: JSON.stringify({ type: "config.changed", entity: "flag", id, version: 0, deleted: true }),
  } as MessageEvent;
}

function entityMessage(entity: "flag" | "segment", id: string, version: number): MessageEvent {
  return {
    data: JSON.stringify({ type: "config.changed", entity, id, version }),
  } as MessageEvent;
}

function queryClientStub(cachedValue?: unknown) {
  const client = {
    getQueryData: vi.fn((_key?: readonly unknown[]) => cachedValue),
    invalidateQueries: vi.fn((_filters?: Parameters<QueryClient["invalidateQueries"]>[0]) =>
      Promise.resolve(),
    ),
  };
  return { ...client, client: client as unknown as QueryClient };
}

function deferred<T>() {
  let resolve: (value: T) => void = () => {
    throw new Error("deferred promise was not initialized");
  };
  const promise = new Promise<T>((resolved) => {
    resolve = resolved;
  });
  return { promise, resolve };
}
