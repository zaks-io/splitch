import { describe, expect, it } from "vitest";
import { MemoryHoldoverWriteAppInventoryClient } from "../sdk-route-binding-cleanup-fixture";
import type {
  HoldoverWriteOutboxStorage,
  HoldoverWritePutPort,
} from "./holdover-write-outbox-core";
import { holdoverWriteJobKey } from "./holdover-write-outbox-core";
import { ensureHoldoverWriteJob } from "./holdover-write-outbox-ensure";
import { handleHoldoverWriteOutboxFetch } from "./holdover-write-outbox-fetch";

const PUT = {
  appId: "app-A",
  experimentId: "exp-1",
  idType: "user",
  targetingKeyHash: "hash-entity",
  runId: "run-1",
  variant: "treatment",
} as const;

class MemoryOutboxStorage implements HoldoverWriteOutboxStorage {
  readonly values = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }
  async put<T>(key: string, value: T): Promise<void> {
    this.values.set(key, value);
  }
  async delete(key: string): Promise<boolean | undefined> {
    const had = this.values.has(key);
    this.values.delete(key);
    return had;
  }
  async list<T>(options?: { prefix?: string }): Promise<Map<string, T>> {
    const out = new Map<string, T>();
    for (const [key, value] of this.values) {
      if (options?.prefix === undefined || key.startsWith(options.prefix)) {
        out.set(key, value as T);
      }
    }
    return out;
  }
  async setAlarm(): Promise<void> {}
  async deleteAlarm(): Promise<void> {}
}

class ConcurrencyGate {
  private chain: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}

describe("Entity /delete inventory unregister race", () => {
  it("privacy deletion removes inventory ref; post-cutoff ensure re-registers", async () => {
    const inventory = new MemoryHoldoverWriteAppInventoryClient();
    await inventory.registerEntity(PUT.appId, {
      idType: PUT.idType,
      targetingKeyHash: PUT.targetingKeyHash,
    });
    const storage = new MemoryOutboxStorage();
    const put: HoldoverWritePutPort = {
      async putHashed() {
        return undefined;
      },
    };
    await ensureHoldoverWriteJob(storage, put, PUT, 1_000, undefined, undefined, {
      sourceCreatedAtMs: 1_000,
    });

    const inventoryNs = {
      idFromName(name: string) {
        return name as unknown as DurableObjectId;
      },
      get() {
        return {
          async fetch(input: RequestInfo | URL, init?: RequestInit) {
            const url = new URL(String(input));
            if (url.pathname === "/mark-entity-purged") {
              await inventory.markEntityPurged(PUT.appId, JSON.parse(String(init?.body)));
              return Response.json({ ok: true });
            }
            if (url.pathname === "/register") {
              return Response.json(
                await inventory.registerEntity(PUT.appId, JSON.parse(String(init?.body))),
              );
            }
            return new Response("not found", { status: 404 });
          },
        };
      },
    };

    const gate = new ConcurrencyGate();
    await gate.run(() =>
      handleHoldoverWriteOutboxFetch(
        storage,
        put,
        new Request("https://holdover-write-outbox.local/delete", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            deleteBeforeTsMs: 1_500,
            appId: PUT.appId,
            idType: PUT.idType,
            targetingKeyHash: PUT.targetingKeyHash,
          }),
        }),
        undefined,
        1_500,
        undefined,
        inventoryNs,
      ),
    );
    expect((await inventory.status(PUT.appId)).entities).toEqual([]);
    expect(storage.values.has(holdoverWriteJobKey(PUT.experimentId))).toBe(false);

    await gate.run(() =>
      handleHoldoverWriteOutboxFetch(
        storage,
        put,
        new Request("https://holdover-write-outbox.local/ensure", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...PUT, sourceCreatedAtMs: 1_600 }),
        }),
        undefined,
        1_600,
        undefined,
        inventoryNs,
      ),
    );
    expect(await inventory.status(PUT.appId)).toMatchObject({
      entities: [{ idType: PUT.idType, targetingKeyHash: PUT.targetingKeyHash }],
    });
  });
});
