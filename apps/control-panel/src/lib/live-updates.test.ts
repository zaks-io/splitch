import type { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LiveUpdateConnection, handleNudge } from "./live-updates";
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
  afterEach(() => vi.useRealTimers());

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
      { queryKey: queryKeys.flag.prefix(scope.appId, scope.environmentId) },
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
      { queryKey: queryKeys.flag.prefix("app_1", "env_prod") },
      { throwOnError: true },
    );
    expect(queryClient.invalidateQueries).not.toHaveBeenCalledWith(
      { queryKey: queryKeys.flag.prefix("app_1", "env_dev") },
      { throwOnError: true },
    );
  });

  it("surfaces staleness after reconnect failures and clears it when the server returns", () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const stale = vi.fn();
    const connection = new LiveUpdateConnection({
      createSocket: () => {
        const socket = fakeSocket();
        sockets.push(socket);
        return socket;
      },
      onStaleDataChange: stale,
      queryClient: queryClientStub().client,
      random: () => 0.5,
      scope,
      url: "ws://panel.test/acme/app/dev/live",
    });

    connection.start();
    socketAt(sockets, 0).onopen?.({} as Event);
    socketAt(sockets, 0).onclose?.({} as CloseEvent);
    vi.advanceTimersByTime(2_000);
    socketAt(sockets, 1).onclose?.({} as CloseEvent);
    vi.advanceTimersByTime(4_000);
    socketAt(sockets, 2).onclose?.({} as CloseEvent);

    expect(stale).toHaveBeenCalledWith(true);
    vi.advanceTimersByTime(8_000);
    socketAt(sockets, 3).onopen?.({} as Event);
    expect(stale).toHaveBeenLastCalledWith(false);
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
