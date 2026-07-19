import { describe, expect, it } from "vitest";
import {
  makeDurableMcpDelegationReplayGuard,
  McpDelegationReplayDurableObject,
} from "./mcp-delegation-replay";

describe("durable MCP delegation replay guard", () => {
  it("claims the Durable Object named for the delegation id", async () => {
    const requests: Request[] = [];
    const guard = makeDurableMcpDelegationReplayGuard({
      idFromName(name) {
        expect(name).toBe("one-use-id");
        return name as unknown as DurableObjectId;
      },
      get() {
        return {
          async fetch(input, init) {
            const request = new Request(input, init);
            requests.push(request);
            return new Response(null, { status: 201 });
          },
        };
      },
    });

    await expect(guard.claim("one-use-id", 130, 100)).resolves.toBe(true);
    expect(requests).toHaveLength(1);
    expect(await requests[0]?.json()).toEqual({ expiresAt: 130, nowSeconds: 100 });
  });

  it("rejects replay and fails closed when the replay service is unavailable", async () => {
    const guard = (status: number) =>
      makeDurableMcpDelegationReplayGuard({
        idFromName: (name) => name as unknown as DurableObjectId,
        get: () => ({ fetch: async () => new Response(null, { status }) }),
      });

    await expect(guard(409).claim("replayed-id", 130, 100)).resolves.toBe(false);
    await expect(guard(503).claim("unavailable-id", 130, 100)).rejects.toThrow(
      "MCP delegation replay claim failed (503)",
    );
  });

  it("stores the first claim and rejects the same Durable Object identity thereafter", async () => {
    const values = new Map<string, unknown>();
    const alarms: number[] = [];
    const durableObject = new McpDelegationReplayDurableObject({
      storage: {
        get: async (key: string) => values.get(key),
        put: async (key: string, value: unknown) => {
          values.set(key, value);
        },
        setAlarm: async (alarm: number) => {
          alarms.push(alarm);
        },
      },
      blockConcurrencyWhile: async <T>(callback: () => Promise<T>) => callback(),
    } as unknown as DurableObjectState);
    const request = () =>
      new Request("https://mcp-delegation-replay.local/claim", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expiresAt: 130, nowSeconds: 100 }),
      });

    await expect(durableObject.fetch(request())).resolves.toMatchObject({ status: 201 });
    await expect(durableObject.fetch(request())).resolves.toMatchObject({ status: 409 });
    expect(alarms).toEqual([130_000]);
  });
});
