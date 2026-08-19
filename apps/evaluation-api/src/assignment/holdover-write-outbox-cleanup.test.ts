import { describe, expect, it } from "vitest";
import { RecordingKv } from "./assignment-store-test-fixtures";
import { makeHoldoverWriteOutboxCleanupHandler } from "./holdover-write-outbox-cleanup";
import { appHoldoverWriteSuppressKey } from "./holdover-write-outbox-core";

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
      environmentId: null,
    } as never,
    requestId: "req-1",
  };
}

describe("holdover write outbox cleanup handler", () => {
  it("App deletion writes the App suppress tombstone", async () => {
    const kv = new RecordingKv();
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
    });

    const response = await handler(handlerArgs({ params: { appId: "app-A" }, query: {} }, "app-A"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deleted: true });
    expect(kv.raw(appHoldoverWriteSuppressKey("app-A"))).toBe("1");
    expect(paths).toEqual([]);
  });

  it("Entity deletion posts suppress then purge on the Entity outbox DO", async () => {
    const kv = new RecordingKv();
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

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deleted: true });
    expect(paths).toEqual(["/suppress", "/purge"]);
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
    });

    const response = await handler(handlerArgs({ params: { appId: "app-A" }, query: {} }, "app-B"));
    expect(response.status).toBe(403);
  });
});
