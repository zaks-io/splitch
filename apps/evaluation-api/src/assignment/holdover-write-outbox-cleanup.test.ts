import { describe, expect, it } from "vitest";
import { RecordingKv } from "./assignment-store-test-fixtures";
import { MemoryHoldoverWriteAppInventoryClient } from "../sdk-route-binding-cleanup-fixture";
import { makeHoldoverWriteOutboxCleanupHandler } from "./holdover-write-outbox-cleanup";

function handlerArgs(
  input: unknown,
  appId: string,
): Parameters<ReturnType<typeof makeHoldoverWriteOutboxCleanupHandler>>[0] {
  return {
    input,
    request: new Request("https://evaluation.internal/internal/apps/app-A/holdover-write-outbox", {
      method: "DELETE",
    }),
    principal: {
      kind: "control-plane",
      actorId: "user_1",
      orgId: "org_1",
      appId,
    } as never,
    requestId: "req-1",
  };
}

describe("holdover write outbox cleanup handler", () => {
  it("App deletion suppresses via inventory then purges registered Entity outboxes", async () => {
    const kv = new RecordingKv();
    const inventory = new MemoryHoldoverWriteAppInventoryClient();
    await inventory.registerEntity("app-A", { idType: "user", targetingKeyHash: "hash-poison" });
    const paths: string[] = [];
    const handler = makeHoldoverWriteOutboxCleanupHandler({
      assignmentsKv: kv,
      holdoverWriteOutbox: {
        idFromName(name) {
          return name as unknown as DurableObjectId;
        },
        get() {
          return {
            async fetch(input: RequestInfo | URL) {
              paths.push(new URL(String(input)).pathname);
              return Response.json({ ok: true });
            },
          };
        },
      },
      holdoverWriteAppInventory: inventory,
    });

    const response = await handler(handlerArgs({ params: { appId: "app-A" }, query: {} }, "app-A"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deleted: true });
    expect(paths).toEqual(["/delete"]);
    expect(await inventory.status("app-A")).toMatchObject({
      suppressed: true,
      deletionComplete: true,
      entities: [],
    });
    // begin-deletion on the real DO also writes KV; memory inventory does not —
    // production boundary covers KV. App coordinator no longer requires a prior
    // standalone KV suppress call from the handler.
  });

  it("App deletion resume is a no-op once inventory marks complete", async () => {
    const inventory = new MemoryHoldoverWriteAppInventoryClient();
    await inventory.beginDeletion("app-A", 1_000);
    await inventory.completeDeletion("app-A");
    let deleteCalls = 0;
    const handler = makeHoldoverWriteOutboxCleanupHandler({
      assignmentsKv: new RecordingKv(),
      holdoverWriteOutbox: {
        idFromName(name) {
          return name as unknown as DurableObjectId;
        },
        get() {
          return {
            async fetch() {
              deleteCalls += 1;
              return Response.json({ ok: true });
            },
          };
        },
      },
      holdoverWriteAppInventory: inventory,
    });

    const response = await handler(handlerArgs({ params: { appId: "app-A" }, query: {} }, "app-A"));
    expect(response.status).toBe(200);
    expect(deleteCalls).toBe(0);
  });

  it("Entity deletion posts /delete handshake with deleteBeforeTs", async () => {
    const kv = new RecordingKv();
    const paths: string[] = [];
    const bodies: unknown[] = [];
    const handler = makeHoldoverWriteOutboxCleanupHandler({
      assignmentsKv: kv,
      holdoverWriteOutbox: {
        idFromName(name) {
          return name as unknown as DurableObjectId;
        },
        get() {
          return {
            async fetch(input: RequestInfo | URL, init?: RequestInit) {
              paths.push(new URL(String(input)).pathname);
              bodies.push(JSON.parse(String(init?.body)));
              return Response.json({ ok: true });
            },
          };
        },
      },
      holdoverWriteAppInventory: new MemoryHoldoverWriteAppInventoryClient(),
    });

    const response = await handler(
      handlerArgs(
        {
          params: { appId: "app-A" },
          query: {
            idType: "user",
            targetingKeyHash: "hash-1",
            deleteBeforeTs: "2026-07-03T00:00:00.000Z",
          },
        },
        "app-A",
      ),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deleted: true });
    expect(paths).toEqual(["/delete"]);
    expect(bodies).toEqual([{ deleteBeforeTsMs: Date.parse("2026-07-03T00:00:00.000Z") }]);
  });

  it("Entity deletion without deleteBeforeTs fails loud", async () => {
    const handler = makeHoldoverWriteOutboxCleanupHandler({
      assignmentsKv: new RecordingKv(),
      holdoverWriteOutbox: {
        idFromName(name) {
          return name as unknown as DurableObjectId;
        },
        get() {
          return {
            async fetch() {
              return Response.json({ ok: true });
            },
          };
        },
      },
      holdoverWriteAppInventory: new MemoryHoldoverWriteAppInventoryClient(),
    });

    const response = await handler(
      handlerArgs(
        {
          params: { appId: "app-A" },
          query: { idType: "user", targetingKeyHash: "hash-1" },
        },
        "app-A",
      ),
    );
    expect(response.status).toBe(400);
  });

  it("refuses a principal scoped to a different App", async () => {
    const handler = makeHoldoverWriteOutboxCleanupHandler({
      assignmentsKv: new RecordingKv(),
      holdoverWriteOutbox: {
        idFromName(name) {
          return name as unknown as DurableObjectId;
        },
        get() {
          return {
            async fetch() {
              return Response.json({ ok: true });
            },
          };
        },
      },
      holdoverWriteAppInventory: new MemoryHoldoverWriteAppInventoryClient(),
    });

    const response = await handler(handlerArgs({ params: { appId: "app-A" }, query: {} }, "app-B"));
    expect(response.status).toBe(403);
  });
});
