import {
  CONTROL_PANEL_DELEGATION_HEADER,
  verifyControlPanelDelegation,
} from "@splitch/control-plane-sdk/control-panel-identity";
import { describe, expect, it, vi } from "vitest";
import { createControlPanelSegmentsClient } from "#lib/segments/control-plane-segments";

const DELEGATION_SECRET = "test-control-panel-delegation-secret-1234";

describe("Control Panel Segments transport", () => {
  it("sends every operation through the scoped binding without browser credentials", async () => {
    const requests: Request[] = [];
    const fetcher = vi.fn(async (request: Request) => {
      requests.push(request);
      if (request.method === "DELETE") return Response.json({ deleted: true });
      if (request.method === "GET" && request.url.endsWith("/segments")) {
        return Response.json({
          items: [{ ...segment(), affectedEnvironmentIds: ["env_1"] }],
          readLimit: 200,
          readTruncated: false,
          cursor: null,
        });
      }
      return Response.json(segment());
    });
    const client = createControlPanelSegmentsClient(
      { fetch: fetcher } as unknown as Fetcher,
      { actorId: "user_1", sessionExpiresAt: 1_800_003_600 },
      "env_1",
      DELEGATION_SECRET,
      {
        nowSeconds: () => 1_800_000_000,
        nonce: () => `nonce_segments_${requests.length}_123456`,
      },
    );

    await client.list({ appId: "app_1" });
    await client.create({
      appId: "app_1",
      name: "Paid plan",
      conditions: [{ attribute: "plan", operator: "eq", value: "paid" }],
    });
    await client.get({ appId: "app_1", segmentId: "segment_1" });
    await client.update({ appId: "app_1", segmentId: "segment_1", name: "Enterprise plan" });
    await client.delete({ appId: "app_1", segmentId: "segment_1" });

    expect(fetcher).toHaveBeenCalledTimes(5);
    for (const request of requests) {
      expect(request.headers.get("authorization")).toBeNull();
      expect(request.headers.get("x-splitch-panel-session")).toBeNull();
      expect(request.headers.get("x-splitch-panel-environment")).toBe("env_1");
      expect(request.headers.get(CONTROL_PANEL_DELEGATION_HEADER)).not.toBeNull();
    }
    await expect(
      verifyControlPanelDelegation(
        requests[3]?.headers.get(CONTROL_PANEL_DELEGATION_HEADER) ?? null,
        requests[3] as Request,
        {
          id: "segments_update",
          appId: "app_1",
          environmentId: "env_1",
          segmentId: "segment_1",
        },
        DELEGATION_SECRET,
        1_800_000_000,
      ),
    ).resolves.toMatchObject({
      actorId: "user_1",
      operation: { id: "segments_update", segmentId: "segment_1" },
    });
  });
});

function segment() {
  return {
    id: "segment_1",
    appId: "app_1",
    name: "Paid plan",
    conditions: [{ attribute: "plan", operator: "eq", value: "paid" }],
    createdAt: "2026-07-29T00:00:00.000Z",
    updatedAt: "2026-07-29T00:00:00.000Z",
  };
}
