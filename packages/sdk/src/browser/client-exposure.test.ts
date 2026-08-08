import { describe, expect, it, vi } from "vitest";
import { FakeLogger } from "../test-fixtures";
import { createSplitchBrowserClient } from "./client";
import { browserOkPayload, FakeBrowserTransport } from "./test-fixtures";

describe("createSplitchBrowserClient: exposure queue", () => {
  it("first read enqueues exactly one Exposure; repeat reads enqueue nothing", async () => {
    const transport = new FakeBrowserTransport([browserOkPayload()]);
    const client = createSplitchBrowserClient({
      clientKey: "pk_test",
      context: { targetingKey: "u1" },
      transport,
      now: () => Date.parse("2026-08-08T00:00:00.000Z"),
    });
    await client.init();

    client.evaluate("new-checkout", false);
    client.evaluate("new-checkout", false);
    client.evaluateDetails("new-checkout", false);
    client.evaluate("legacy-banner", false);

    await client.flush();

    expect(transport.redeemCalls).toHaveLength(1);
    const batch = transport.redeemCalls[0]?.exposures;
    expect(batch).toHaveLength(1);
    expect(batch?.[0]).toMatchObject({
      exposureTicket: "ticket-checkout",
      clientTimestamp: "2026-08-08T00:00:00.000Z",
    });
    expect(batch?.[0]?.exposureId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it("failed flush is observable and retains the same exposureId for retry", async () => {
    const logger = new FakeLogger();
    const exposureId = "11111111-1111-4111-8111-111111111111";
    const randomUUID = vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(exposureId);

    const transport = new FakeBrowserTransport(
      [browserOkPayload()],
      [
        {
          status: null,
          results: null,
          errorCode: "SDK_TRANSPORT_NETWORK",
          errorMessage: "network down",
          cause: new TypeError("network down"),
        },
        {
          status: 202,
          results: [{ exposureId, status: "accepted", code: null }],
        },
      ],
    );
    const client = createSplitchBrowserClient({
      clientKey: "pk_test",
      context: { targetingKey: "u1" },
      transport,
      logger,
    });
    await client.init();
    client.evaluate("new-checkout", false);

    await expect(client.flush()).rejects.toMatchObject({ code: "SDK_TRANSPORT_NETWORK" });
    expect(logger.errors.some((row) => row.message.includes("SDK_TRANSPORT_NETWORK"))).toBe(true);

    await client.flush();
    expect(transport.redeemCalls).toHaveLength(2);
    expect(transport.redeemCalls[0]?.exposures[0]?.exposureId).toBe(exposureId);
    expect(transport.redeemCalls[1]?.exposures[0]?.exposureId).toBe(exposureId);

    randomUUID.mockRestore();
  });

  it("pagehide flush uses authenticated fetch with keepalive", async () => {
    const listeners = new Map<string, Set<() => void>>();
    const fakeWindow = {
      addEventListener(type: string, handler: () => void) {
        let set = listeners.get(type);
        if (set === undefined) {
          set = new Set();
          listeners.set(type, set);
        }
        set.add(handler);
      },
      removeEventListener(type: string, handler: () => void) {
        listeners.get(type)?.delete(handler);
      },
    } as unknown as Window;

    const transport = new FakeBrowserTransport([browserOkPayload()]);
    const client = createSplitchBrowserClient({
      clientKey: "pk_test",
      context: { targetingKey: "u1" },
      transport,
      window: fakeWindow,
      document: null,
    });
    await client.init();
    client.evaluate("new-checkout", false);

    expect(listeners.get("pagehide")?.size).toBe(1);
    for (const handler of listeners.get("pagehide") ?? []) {
      handler();
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(transport.redeemCalls.length).toBeGreaterThan(0);
    expect(transport.redeemCalls[0]?.keepalive).toBe(true);
  });

  it("empty flush performs no network I/O", async () => {
    const transport = new FakeBrowserTransport([browserOkPayload()]);
    const client = createSplitchBrowserClient({
      clientKey: "pk_test",
      context: { targetingKey: "u1" },
      transport,
    });
    await client.init();
    const results = await client.flush();
    expect(results).toEqual([]);
    expect(transport.redeemCalls).toHaveLength(0);
  });
});
