import { describe, expect, it } from "vitest";
import { createHoldoverWriteOutboxCleanup } from "./holdover-write-outbox-cleanup";

describe("createHoldoverWriteOutboxCleanup", () => {
  it("POSTs App suppress cleanup to EVALUATION_API", async () => {
    const requests: Request[] = [];
    const evaluation = {
      async fetch(input: RequestInfo | URL, init?: RequestInit) {
        const request = input instanceof Request ? input : new Request(input, init);
        requests.push(request);
        return Response.json({ deleted: true });
      },
    } as Fetcher;

    const cleanup = createHoldoverWriteOutboxCleanup(evaluation);
    await cleanup.delete({
      appId: "app_1",
      actorId: "user_1",
      orgId: "org_1",
      requestId: "req_1",
    });

    expect(requests).toHaveLength(1);
    const request = requests[0];
    expect(request?.method).toBe("DELETE");
    expect(new URL(request?.url ?? "").pathname).toBe("/internal/apps/app_1/holdover-write-outbox");
  });

  it("includes Entity identity query params when provided", async () => {
    let url = "";
    const evaluation = {
      async fetch(input: RequestInfo | URL, init?: RequestInit) {
        const request = input instanceof Request ? input : new Request(input, init);
        url = request.url;
        return Response.json({ deleted: true });
      },
    } as Fetcher;

    await createHoldoverWriteOutboxCleanup(evaluation).delete({
      appId: "app_1",
      idType: "user",
      targetingKeyHash: "hash-1",
      actorId: "user_1",
      orgId: "org_1",
      requestId: "req_1",
    });

    const parsed = new URL(url);
    expect(parsed.searchParams.get("idType")).toBe("user");
    expect(parsed.searchParams.get("targetingKeyHash")).toBe("hash-1");
  });

  it("fails loud without EVALUATION_API", async () => {
    const cleanup = createHoldoverWriteOutboxCleanup(undefined);
    await expect(
      cleanup.delete({
        appId: "app_1",
        actorId: "user_1",
        orgId: null,
        requestId: "req_1",
      }),
    ).rejects.toThrow(/EVALUATION_API is required/);
  });
});
