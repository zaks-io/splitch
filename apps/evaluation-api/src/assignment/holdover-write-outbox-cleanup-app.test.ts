import { describe, expect, it } from "vitest";
import { RecordingKv } from "./assignment-store-test-fixtures";
import { MemoryHoldoverWriteAppInventoryClient } from "../sdk-route-binding-cleanup-fixture";
import { makeHoldoverWriteOutboxCleanupHandler } from "./holdover-write-outbox-cleanup";

const GENERATION_ID = "req-generation-1";

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

function stubOutbox(onFetch?: (path: string, body: unknown) => void) {
  return {
    idFromName(name: string) {
      return name as unknown as DurableObjectId;
    },
    get() {
      return {
        async fetch(input: RequestInfo | URL, init?: RequestInit) {
          onFetch?.(new URL(String(input)).pathname, JSON.parse(String(init?.body ?? "{}")));
          return Response.json({ ok: true });
        },
      };
    },
  };
}

describe("holdover write outbox cleanup App phases", () => {
  it("prepare freezes without purging Entity outboxes", async () => {
    const inventory = new MemoryHoldoverWriteAppInventoryClient();
    await inventory.registerEntity("app-A", { idType: "user", targetingKeyHash: "hash-poison" });
    let deleteCalls = 0;
    const handler = makeHoldoverWriteOutboxCleanupHandler({
      assignmentsKv: new RecordingKv(),
      holdoverWriteOutbox: stubOutbox(() => {
        deleteCalls += 1;
      }),
      holdoverWriteAppInventory: inventory,
    });
    const response = await handler(
      handlerArgs(
        {
          params: { appId: "app-A" },
          query: { phase: "prepare", generationId: GENERATION_ID },
        },
        "app-A",
      ),
    );
    expect(response.status).toBe(200);
    expect(deleteCalls).toBe(0);
    expect(await inventory.status("app-A")).toMatchObject({
      suppressed: true,
      deletionComplete: false,
      entities: [{ idType: "user", targetingKeyHash: "hash-poison" }],
    });
  });

  it("finalize enters the App inventory finalizer instead of draining outboxes here", async () => {
    const purged: string[] = [];
    const inventory = new MemoryHoldoverWriteAppInventoryClient({
      purge: {
        async purgeEntity(identity) {
          purged.push(`${identity.idType}:${identity.targetingKeyHash}`);
        },
      },
    });
    await inventory.registerEntity("app-A", { idType: "user", targetingKeyHash: "hash-poison" });
    await inventory.beginDeletion("app-A", GENERATION_ID, 1_000);
    await inventory.markD1Deleted("app-A", GENERATION_ID);
    const bodies: unknown[] = [];
    const handler = makeHoldoverWriteOutboxCleanupHandler({
      assignmentsKv: new RecordingKv(),
      holdoverWriteOutbox: stubOutbox((_path, body) => bodies.push(body)),
      holdoverWriteAppInventory: inventory,
    });
    const response = await handler(
      handlerArgs(
        {
          params: { appId: "app-A" },
          query: { phase: "finalize", generationId: GENERATION_ID },
        },
        "app-A",
      ),
    );
    expect(response.status).toBe(200);
    expect(bodies).toEqual([]);
    expect(purged).toEqual(["user:hash-poison"]);
    expect(await inventory.status("app-A")).toMatchObject({
      suppressed: true,
      deletionComplete: true,
      entities: [],
    });
  });

  it("cancel restores freeze and wakes Entity alarms", async () => {
    const resumes: string[] = [];
    const inventory = new MemoryHoldoverWriteAppInventoryClient({
      resume: {
        async resumeAlarms(identity) {
          resumes.push(`${identity.idType}:${identity.targetingKeyHash}`);
        },
      },
    });
    await inventory.registerEntity("app-A", { idType: "user", targetingKeyHash: "hash-1" });
    await inventory.beginDeletion("app-A", GENERATION_ID, 1_000);
    const handler = makeHoldoverWriteOutboxCleanupHandler({
      assignmentsKv: new RecordingKv(),
      holdoverWriteOutbox: stubOutbox(),
      holdoverWriteAppInventory: inventory,
    });
    const response = await handler(
      handlerArgs(
        {
          params: { appId: "app-A" },
          query: { phase: "cancel", generationId: GENERATION_ID },
        },
        "app-A",
      ),
    );
    expect(response.status).toBe(200);
    expect(resumes).toEqual(["user:hash-1"]);
    expect(await inventory.status("app-A")).toMatchObject({
      suppressed: false,
      deletionComplete: false,
      entities: [{ idType: "user", targetingKeyHash: "hash-1" }],
    });
  });

  it("finalize resume is a no-op once inventory marks complete", async () => {
    const inventory = new MemoryHoldoverWriteAppInventoryClient();
    await inventory.beginDeletion("app-A", GENERATION_ID, 1_000);
    await inventory.markD1Deleted("app-A", GENERATION_ID, 1_000);
    await inventory.finalizeDeletion("app-A", GENERATION_ID, 1_000);
    let deleteCalls = 0;
    const handler = makeHoldoverWriteOutboxCleanupHandler({
      assignmentsKv: new RecordingKv(),
      holdoverWriteOutbox: stubOutbox(() => {
        deleteCalls += 1;
      }),
      holdoverWriteAppInventory: inventory,
    });
    const response = await handler(
      handlerArgs(
        {
          params: { appId: "app-A" },
          query: { phase: "finalize", generationId: GENERATION_ID },
        },
        "app-A",
      ),
    );
    expect(response.status).toBe(200);
    expect(deleteCalls).toBe(0);
  });

  it("App deletion without phase fails loud", async () => {
    const handler = makeHoldoverWriteOutboxCleanupHandler({
      assignmentsKv: new RecordingKv(),
      holdoverWriteOutbox: stubOutbox(),
      holdoverWriteAppInventory: new MemoryHoldoverWriteAppInventoryClient(),
    });
    const response = await handler(handlerArgs({ params: { appId: "app-A" }, query: {} }, "app-A"));
    expect(response.status).toBe(400);
  });
});
