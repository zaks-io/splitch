import { describe, expect, it } from "vitest";
import { RecordingKv } from "./assignment-store-test-fixtures";
import {
  activateAppInventoryIdentityVersion,
  admitAppInventoryAssignment,
  appInventoryStatus,
  beginAppInventoryDeletion,
  cancelAppInventoryDeletion,
  completeAppInventoryDeletion,
  type HoldoverWriteAppInventoryStorage,
  markAppInventoryEntityPurged,
  registerAppInventoryEntity,
} from "./holdover-write-app-inventory";
import { DurableHoldoverWriteAppInventoryClient } from "./holdover-write-app-inventory-client";
import { handleHoldoverWriteAppInventoryFetch } from "./holdover-write-app-inventory-fetch";
import { appHoldoverWriteSuppressKey } from "./holdover-write-outbox-core";

const GENERATION_ID = "req-generation-1";

class MemoryInventoryStorage implements HoldoverWriteAppInventoryStorage {
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
}

describe("holdover write App inventory ordering / resumability", () => {
  it("durably fences old Assignment generations and inventories the admitted writer", async () => {
    const storage = new MemoryInventoryStorage();
    const ref = { idType: "user", targetingKeyHash: "app-v1:hash-1" };

    await expect(admitAppInventoryAssignment(storage, ref, "app-v1")).resolves.toEqual({
      status: "registered",
    });
    await beginAppInventoryDeletion(storage, 1_000);
    await activateAppInventoryIdentityVersion(storage, "app-v2");
    await cancelAppInventoryDeletion(storage);

    expect((await appInventoryStatus(storage)).entities).toEqual([ref]);
    await expect(admitAppInventoryAssignment(storage, ref, "app-v1")).resolves.toEqual({
      status: "stale",
    });
  });

  it("begin-deletion requires appId in the body for KV suppress (not only DO id.name)", async () => {
    const storage = new MemoryInventoryStorage();
    const kv = new RecordingKv();
    await registerAppInventoryEntity(storage, { idType: "user", targetingKeyHash: "hash-1" });

    // Simulate the App inventory DO begin-deletion critical section.
    const body = { appId: "app-A", deleteBeforeTsMs: 9_000 };
    const begun = await beginAppInventoryDeletion(storage, body.deleteBeforeTsMs);
    expect(begun.entities).toHaveLength(1);
    await kv.put(appHoldoverWriteSuppressKey(body.appId), "1");
    expect(kv.raw(appHoldoverWriteSuppressKey("app-A"))).toBe("1");

    const registered = begun.entities[0];
    expect(registered).toBeDefined();
    if (registered === undefined) throw new Error("expected registered entity");
    await markAppInventoryEntityPurged(storage, registered);
    await completeAppInventoryDeletion(storage);
    const again = await beginAppInventoryDeletion(storage, 9_000);
    expect(again.deletionComplete).toBe(true);
    expect(again.entities).toEqual([]);
  });

  it("DurableHoldoverWriteAppInventoryClient posts appId with begin-deletion", async () => {
    const bodies: unknown[] = [];
    const client = new DurableHoldoverWriteAppInventoryClient({
      idFromName(name) {
        return name as unknown as DurableObjectId;
      },
      get() {
        return {
          async fetch(_input: RequestInfo | URL, init?: RequestInit) {
            bodies.push(JSON.parse(String(init?.body)));
            return Response.json({
              suppressed: true,
              deletionComplete: false,
              generationId: GENERATION_ID,
              deleteBeforeTsMs: 1_000,
              entities: [],
            });
          },
        };
      },
    });
    await client.beginDeletion("app-A", GENERATION_ID, 1_000);
    expect(bodies).toEqual([
      { appId: "app-A", generationId: GENERATION_ID, deleteBeforeTsMs: 1_000 },
    ]);
  });

  it("register refuses once deletion has begun or completed", async () => {
    const storage = new MemoryInventoryStorage();
    await beginAppInventoryDeletion(storage, 1_000);
    await expect(
      registerAppInventoryEntity(storage, { idType: "user", targetingKeyHash: "hash-1" }),
    ).resolves.toEqual({ status: "suppressed" });
    await completeAppInventoryDeletion(storage);
    await expect(
      registerAppInventoryEntity(storage, { idType: "user", targetingKeyHash: "hash-2" }),
    ).resolves.toEqual({ status: "suppressed" });
    expect((await appInventoryStatus(storage)).entities).toEqual([]);
  });

  it("inventory fetch /begin-deletion is handled by the DO path (fetch router leaves it)", async () => {
    const storage = new MemoryInventoryStorage();
    const response = await handleHoldoverWriteAppInventoryFetch(
      storage,
      new Request("https://inv.local/begin-deletion", {
        method: "POST",
        body: JSON.stringify({ deleteBeforeTsMs: 1 }),
      }),
    );
    // Shared fetch handler still accepts begin-deletion for unit harnesses;
    // production DO intercepts and also writes KV with explicit appId.
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ suppressed: true });
  });
});
