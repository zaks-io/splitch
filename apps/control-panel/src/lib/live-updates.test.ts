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

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("nudge retry cancellation", () => {
  it("does not report a retry after cancellation wins the failed attempt", async () => {
    const queryClient = queryClientStub();
    queryClient.invalidateQueries.mockRejectedValue(new Error("read API unavailable"));
    const isCancelled = vi
      .fn()
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(false)
      .mockReturnValue(true);
    const onStaleData = vi.fn();

    await handleNudge(deletedMessage("flag_1").data, scope, queryClient.client, {
      isCancelled,
      onStaleData,
    });

    expect(onStaleData).not.toHaveBeenCalled();
  });
});

describe("live updates", () => {
  it("invalidates only the nudged flag prefix", async () => {
    const queryClient = queryClientStub({ version: 2 });
    queryClient.invalidateQueries.mockImplementation(() => {
      queryClient.getQueryData.mockReturnValue({ version: 3 });
      return Promise.resolve();
    });

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

  it("refetches the active route for a nudge", async () => {
    const queryClient = queryClientStub();
    const refetchRoute = vi.fn(() => Promise.resolve());

    await handleNudge(message("flag_1", 3).data, scope, queryClient.client, { refetchRoute });

    expect(refetchRoute).toHaveBeenCalledOnce();
  });

  it("always invalidates a deleted Flag without reporting fresh data", async () => {
    const queryClient = queryClientStub({ version: 99 });
    const onFreshData = vi.fn();

    await handleNudge(
      JSON.stringify({
        type: "config.changed",
        entity: "flag",
        id: "flag_1",
        version: 0,
        deleted: true,
      }),
      scope,
      queryClient.client,
      { onFreshData },
    );

    expect(queryClient.invalidateQueries).toHaveBeenCalledWith(
      { queryKey: queryKeys.flag.prefix(scope.appId, scope.environmentId), refetchType: "all" },
      { throwOnError: true },
    );
    expect(onFreshData).not.toHaveBeenCalled();
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
    expect(refetchRoute).toHaveBeenCalledTimes(3);
    recovery.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(stale).toHaveBeenLastCalledWith(false);
  });
});

describe("scope startup", () => {
  it("refreshes a replacement Environment before its socket opens", async () => {
    const queryClient = queryClientStub();
    const refetchRoute = vi.fn(() => Promise.resolve());
    const connection = new LiveUpdateConnection({
      createSocket: () => fakeSocket(),
      queryClient: queryClient.client,
      refetchRoute,
      scope: { appId: "app_1", environmentId: "env_prod" },
      url: "ws://panel.test/acme/app/prod/live",
    });

    connection.start();
    await Promise.resolve();

    expect(queryClient.invalidateQueries).toHaveBeenCalledWith(
      { queryKey: queryKeys.app.root("app_1", "env_prod"), refetchType: "all" },
      { throwOnError: true },
    );
    expect(refetchRoute).toHaveBeenCalledOnce();
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
