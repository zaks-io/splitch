import type { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleNudge, LiveUpdateConnection } from "./live-updates";
import { queryKeys } from "./query-keys";

type FakeSocket = {
  close: () => void;
  closeSpy: ReturnType<typeof vi.fn>;
  onclose: ((event: CloseEvent) => unknown) | null;
  onerror: ((event: Event) => unknown) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onopen: ((event: Event) => unknown) | null;
};

const scope = { appId: "app_1", environmentId: "env_dev" };

describe("live updates", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("invalidates only the nudged flag prefix", async () => {
    const queryClient = queryClientStub({ version: 2 });

    await handleNudge(
      JSON.stringify({ type: "config.changed", entity: "flag", id: "flag_1", version: 3 }),
      scope,
      queryClient.client,
    );

    expect(queryClient.getQueryData).toHaveBeenCalledWith(
      queryKeys.flag.detail(scope.appId, scope.environmentId, "flag_1"),
    );
    expect(queryClient.invalidateQueries).toHaveBeenCalledTimes(1);
    expect(queryClient.invalidateQueries).toHaveBeenCalledWith(
      { queryKey: queryKeys.flag.prefix(scope.appId, scope.environmentId), refetchType: "all" },
      { throwOnError: true },
    );
  });

  it("invalidates the Experiment prefix for a canonical Run nudge", async () => {
    const queryClient = queryClientStub();

    await handleNudge(
      JSON.stringify({ type: "config.changed", entity: "run", id: "run_1", version: 3 }),
      scope,
      queryClient.client,
    );

    expect(queryClient.getQueryData).not.toHaveBeenCalled();
    expect(queryClient.invalidateQueries).toHaveBeenCalledWith(
      {
        queryKey: queryKeys.experiment.prefix(scope.appId, scope.environmentId),
        refetchType: "all",
      },
      { throwOnError: true },
    );
  });

  it("does not react to a nudge from a detached Environment socket", async () => {
    const sockets: FakeSocket[] = [];
    const queryClient = queryClientStub();
    const createSocket = () => {
      const socket = fakeSocket();
      sockets.push(socket);
      return socket;
    };
    const dev = new LiveUpdateConnection({
      createSocket,
      queryClient: queryClient.client,
      scope,
      url: "ws://panel.test/acme/app/dev/live",
    });
    dev.start();
    socketAt(sockets, 0).onopen?.({} as Event);
    dev.stop();

    const prod = new LiveUpdateConnection({
      createSocket,
      queryClient: queryClient.client,
      scope: { appId: "app_1", environmentId: "env_prod" },
      url: "ws://panel.test/acme/app/prod/live",
    });
    prod.start();
    socketAt(sockets, 1).onopen?.({} as Event);
    socketAt(sockets, 0).onmessage?.(message("flag_1", 1));
    socketAt(sockets, 1).onmessage?.(message("flag_1", 1));
    await Promise.resolve();

    expect(socketAt(sockets, 0).closeSpy).toHaveBeenCalledOnce();
    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: queryKeys.app.root(scope.appId, scope.environmentId),
    });
    expect(queryClient.invalidateQueries).toHaveBeenCalledWith(
      { queryKey: queryKeys.flag.prefix("app_1", "env_prod"), refetchType: "all" },
      { throwOnError: true },
    );
    expect(queryClient.invalidateQueries).not.toHaveBeenCalledWith(
      { queryKey: queryKeys.flag.prefix("app_1", "env_dev"), refetchType: "all" },
      { throwOnError: true },
    );
  });

  it("keeps stale data visible until a reconnect refetch succeeds", async () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const stale = vi.fn();
    const queryClient = queryClientStub();
    let routeRefetch = () => Promise.resolve();
    const refetchRoute = vi.fn(() => routeRefetch());
    const connection = new LiveUpdateConnection({
      createSocket: () => {
        const socket = fakeSocket();
        sockets.push(socket);
        return socket;
      },
      onStaleDataChange: stale,
      queryClient: queryClient.client,
      random: () => 0.5,
      refetchRoute,
      scope,
      url: "ws://panel.test/acme/app/dev/live",
    });

    connection.start();
    socketAt(sockets, 0).onopen?.({} as Event);
    await vi.advanceTimersByTimeAsync(0);
    socketAt(sockets, 0).onclose?.({} as CloseEvent);
    vi.advanceTimersByTime(2_000);
    socketAt(sockets, 1).onclose?.({} as CloseEvent);
    vi.advanceTimersByTime(4_000);
    socketAt(sockets, 2).onclose?.({} as CloseEvent);

    expect(stale).toHaveBeenCalledWith(true);
    vi.advanceTimersByTime(8_000);
    const recovery = deferred<void>();
    routeRefetch = () => recovery.promise;
    socketAt(sockets, 3).onopen?.({} as Event);

    await vi.advanceTimersByTimeAsync(0);
    expect(stale).toHaveBeenLastCalledWith(true);
    expect(refetchRoute).toHaveBeenCalledTimes(2);
    recovery.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(stale).toHaveBeenLastCalledWith(false);
  });

  it("retries failed nudge refetches after 2s, 4s, and 8s before giving up", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const attempts: number[] = [];
    const queryClient = queryClientStub();
    const startedAt = Date.now();
    queryClient.invalidateQueries.mockImplementation(() => {
      attempts.push(Date.now());
      return Promise.reject(new Error("read API unavailable"));
    });

    const pending = handleNudge(message("flag_1", 1).data, scope, queryClient.client);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(4_000);
    await vi.advanceTimersByTimeAsync(8_000);
    await pending;

    expect(attempts.map((at) => at - startedAt)).toEqual([0, 2_000, 6_000, 14_000]);
  });
});

function fakeSocket(): FakeSocket {
  const closeSpy = vi.fn();
  return {
    close: closeSpy as () => void,
    closeSpy,
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
  return {
    data: JSON.stringify({ type: "config.changed", entity: "flag", id, version }),
  } as MessageEvent;
}

function queryClientStub(cachedValue?: unknown) {
  const client = {
    getQueryData: vi.fn(() => cachedValue),
    invalidateQueries: vi.fn(() => Promise.resolve()),
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
