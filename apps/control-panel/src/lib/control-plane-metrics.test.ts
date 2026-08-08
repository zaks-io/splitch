import {
  CONTROL_PANEL_DELEGATION_HEADER,
  verifyControlPanelDelegation,
} from "@splitch/control-plane-sdk/control-panel-identity";
import { describe, expect, it, vi } from "vitest";
import { createControlPanelMetricsClient } from "./control-plane-metrics";

const DELEGATION_SECRET = "test-control-panel-delegation-secret-1234";

describe("Control Panel Metrics transport", () => {
  it("sends every operation through the scoped binding without browser credentials", async () => {
    const requests: Request[] = [];
    const fetcher = vi.fn(async (request: Request) => {
      requests.push(request);
      if (request.method === "DELETE") return Response.json({ deleted: true });
      if (request.method === "GET" && request.url.endsWith("/metrics")) {
        return Response.json({ items: [metric()] });
      }
      return Response.json(metric());
    });
    const client = createControlPanelMetricsClient(
      { fetch: fetcher } as unknown as Fetcher,
      { actorId: "user_1", sessionExpiresAt: 1_800_003_600 },
      "env_1",
      DELEGATION_SECRET,
      {
        nowSeconds: () => 1_800_000_000,
        nonce: () => `nonce_metrics_${requests.length}_123456`,
      },
    );

    await client.list({ appId: "app_1" });
    await client.create({
      appId: "app_1",
      name: "Orders",
      key: "orders",
      kind: "count",
      eventDefinitionId: "order_completed",
      eventFieldName: "quantity",
    });
    await client.get({ appId: "app_1", metricId: "metric_1" });
    await client.update({ appId: "app_1", metricId: "metric_1", name: "Completed orders" });
    await client.delete({ appId: "app_1", metricId: "metric_1" });

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
          id: "metrics_update",
          appId: "app_1",
          environmentId: "env_1",
          metricId: "metric_1",
        },
        DELEGATION_SECRET,
        1_800_000_000,
      ),
    ).resolves.toMatchObject({
      actorId: "user_1",
      operation: { id: "metrics_update", metricId: "metric_1" },
    });
  });
});

function metric() {
  return {
    id: "metric_1",
    appId: "app_1",
    key: "orders",
    name: "Orders",
    kind: "count",
    eventDefinitionId: "order_completed",
    eventFieldName: "quantity",
    createdAt: "2026-07-29T00:00:00.000Z",
  };
}
