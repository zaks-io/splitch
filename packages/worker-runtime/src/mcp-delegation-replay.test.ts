import { describe, expect, it } from "vitest";
import {
  makeDurableMcpDelegationReplayGuard,
  mcpDelegationReplayShardName,
  McpDelegationReplayDurableObject,
} from "./mcp-delegation-replay";

describe("durable MCP delegation replay guard", () => {
  it("claims a reusable shard with the delegation id in the body", async () => {
    const requests: Request[] = [];
    const guard = makeDurableMcpDelegationReplayGuard({
      getByName(name) {
        expect(name).toBe(mcpDelegationReplayShardName("one-use-id"));
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
    expect(await requests[0]?.json()).toEqual({
      jti: "one-use-id",
      expiresAt: 130,
      nowSeconds: 100,
      replayVersion: 2,
    });
  });

  it("routes version 1 credentials to their legacy per-JTI object during cutover", async () => {
    const names: string[] = [];
    const guard = makeDurableMcpDelegationReplayGuard({
      getByName(name) {
        names.push(name);
        return { fetch: async () => new Response(null, { status: 201 }) };
      },
    });

    await expect(guard.claim("legacy-delegation-id", 130, 100, 1)).resolves.toBe(true);
    expect(names).toEqual(["legacy-delegation-id"]);
  });

  it("rejects replay and fails closed when the replay service is unavailable", async () => {
    const guard = (status: number) =>
      makeDurableMcpDelegationReplayGuard({
        getByName: () => ({ fetch: async () => new Response(null, { status }) }),
      });

    await expect(guard(409).claim("replayed-id", 130, 100)).resolves.toBe(false);
    await expect(guard(503).claim("unavailable-id", 130, 100)).rejects.toThrow(
      "MCP delegation replay claim failed (503)",
    );
  });

  it("stores multiple claims in one shard and rejects a replayed delegation id", async () => {
    const fixture = replayStorageFixture();
    const durableObject = new McpDelegationReplayDurableObject({
      storage: fixture.storage,
    } as unknown as DurableObjectState);
    const request = (jti: string) =>
      new Request("https://mcp-delegation-replay.local/claim", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jti, expiresAt: 130, nowSeconds: 100, replayVersion: 2 }),
      });

    await expect(durableObject.fetch(request("first"))).resolves.toMatchObject({ status: 201 });
    await expect(durableObject.fetch(request("second"))).resolves.toMatchObject({ status: 201 });
    await expect(durableObject.fetch(request("first"))).resolves.toMatchObject({ status: 409 });
    expect(fixture.alarms).toEqual([130_000]);
  });

  it("honors a version 1 claim already stored before the shard migration", async () => {
    const values = new Map<string, unknown>([["claimed-until", 130]]);
    const storage = {
      sql: { exec: () => ({ toArray: () => [] }) },
      transaction: async <T>(fn: (txn: DurableObjectTransaction) => Promise<T>) =>
        fn(storage as unknown as DurableObjectTransaction),
      get: async (key: string) => values.get(key),
      put: async (key: string, value: unknown) => values.set(key, value),
      setAlarm: async () => undefined,
    };
    const durableObject = new McpDelegationReplayDurableObject({
      storage,
    } as unknown as DurableObjectState);
    const request = new Request("https://mcp-delegation-replay.local/claim", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jti: "legacy-delegation-id",
        expiresAt: 130,
        nowSeconds: 100,
        replayVersion: 1,
      }),
    });

    await expect(durableObject.fetch(request)).resolves.toMatchObject({ status: 409 });
  });
});

function replayStorageFixture() {
  const claims = new Map<string, number>();
  const alarms: number[] = [];
  let alarm: number | null = null;
  return {
    alarms,
    storage: {
      sql: { exec: (query: string, ...bindings: unknown[]) => replaySql(claims, query, bindings) },
      getAlarm: async () => alarm,
      setAlarm: async (scheduledTime: number) => {
        alarm = scheduledTime;
        alarms.push(scheduledTime);
      },
      deleteAll: async () => claims.clear(),
    },
  };
}

function replaySql(claims: Map<string, number>, query: string, bindings: unknown[]) {
  if (query.startsWith("DELETE FROM claims")) deleteExpired(claims, bindings[0] as number);
  if (query.startsWith("INSERT OR IGNORE")) return insertClaim(claims, bindings);
  if (query.startsWith("SELECT min")) {
    const next = claims.size === 0 ? null : Math.min(...claims.values());
    return { one: () => ({ next }) };
  }
  return { toArray: () => [] };
}

function deleteExpired(claims: Map<string, number>, nowSeconds: number): void {
  for (const [jti, expiresAt] of claims) {
    if (expiresAt <= nowSeconds) claims.delete(jti);
  }
}

function insertClaim(claims: Map<string, number>, bindings: unknown[]) {
  const [jti, expiresAt] = bindings as [string, number];
  const inserted = !claims.has(jti);
  if (inserted) claims.set(jti, expiresAt);
  return { toArray: () => (inserted ? [{ jti }] : []) };
}
