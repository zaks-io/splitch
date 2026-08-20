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

describe("holdover write outbox cleanup Entity path", () => {
  it("Entity deletion posts /delete with identity + deleteBeforeTs", async () => {
    const paths: string[] = [];
    const bodies: unknown[] = [];
    const handler = makeHoldoverWriteOutboxCleanupHandler({
      assignmentsKv: new RecordingKv(),
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
    expect(paths).toEqual(["/delete"]);
    expect(bodies).toEqual([
      {
        deleteBeforeTsMs: Date.parse("2026-07-03T00:00:00.000Z"),
        appId: "app-A",
        idType: "user",
        targetingKeyHash: "hash-1",
      },
    ]);
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
        { params: { appId: "app-A" }, query: { idType: "user", targetingKeyHash: "hash-1" } },
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
    const response = await handler(
      handlerArgs({ params: { appId: "app-A" }, query: { phase: "prepare" } }, "app-B"),
    );
    expect(response.status).toBe(403);
  });
});
