import { boundListRead } from "@splitch/contracts";
import { describe, expect, it, vi } from "vitest";
import { createPanelMetricsClient } from "./panel-metrics";

describe("panel Metrics binding transport", () => {
  it("round-trips list, create, get, update, and delete with typed bodies", async () => {
    const requests: Array<{ method: string; url: string; body: string }> = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      requests.push({
        method: request.method,
        url: request.url,
        body: await request.clone().text(),
      });
      if (request.method === "DELETE") return Response.json({ deleted: true });
      if (request.method === "GET" && request.url.endsWith("/metrics")) {
        return Response.json(boundListRead([metric()]));
      }
      const body = request.method === "GET" ? {} : ((await request.json()) as object);
      return Response.json({ ...metric(), ...body });
    });
    const client = createPanelMetricsClient({ fetch: fetcher });

    await expect(client.list({ appId: "app_1" })).resolves.toMatchObject({
      ok: true,
      data: { items: [{ kind: "count" }] },
    });
    await expect(
      client.create({
        appId: "app_1",
        key: "orders",
        name: "Orders",
        kind: "count",
        eventDefinitionId: "order_completed",
        eventFieldName: "quantity",
      }),
    ).resolves.toMatchObject({ ok: true, data: { key: "orders" } });
    await expect(client.get({ appId: "app_1", metricId: "metric_1" })).resolves.toMatchObject({
      ok: true,
      data: { id: "metric_1" },
    });
    await expect(
      client.update({
        appId: "app_1",
        metricId: "metric_1",
        name: "Completed orders",
      }),
    ).resolves.toMatchObject({ ok: true, data: { name: "Completed orders" } });
    await expect(client.delete({ appId: "app_1", metricId: "metric_1" })).resolves.toMatchObject({
      ok: true,
      data: { deleted: true },
    });

    expect(requests.map(({ method, url }) => [method, url])).toEqual([
      ["GET", "https://control-plane.internal/apps/app_1/metrics"],
      ["POST", "https://control-plane.internal/apps/app_1/metrics"],
      ["GET", "https://control-plane.internal/apps/app_1/metrics/metric_1"],
      ["PATCH", "https://control-plane.internal/apps/app_1/metrics/metric_1"],
      ["DELETE", "https://control-plane.internal/apps/app_1/metrics/metric_1"],
    ]);
    expect(JSON.parse(requests[1]?.body ?? "{}")).toMatchObject({
      appId: "app_1",
      kind: "count",
      eventFieldName: "quantity",
    });
    expect(JSON.parse(requests[3]?.body ?? "{}")).toEqual({
      name: "Completed orders",
    });
  });

  it("rejects invalid successful response bodies", async () => {
    const client = createPanelMetricsClient({
      fetch: vi.fn(async () => Response.json(boundListRead([{ kind: "histogram" }]))),
    });

    await expect(client.list({ appId: "app_1" })).rejects.toThrow(
      "panel_metrics_list returned an invalid response body",
    );
  });

  it("keeps a migrated Ratio readable so the Control Panel can repair it", async () => {
    const legacyRatio = {
      id: "metric_ratio_legacy",
      appId: "app_1",
      key: "legacy-rate",
      name: "Legacy rate",
      kind: "ratio",
      eventDefinitionId: "event_definition_numerator",
      denominator: { metricId: "metric_denominator" },
      configurationStatus: "needs_configuration",
      createdAt: "2026-07-29T00:00:00.000Z",
    };
    const client = createPanelMetricsClient({
      fetch: vi.fn(async () => Response.json(boundListRead([legacyRatio]))),
    });

    await expect(client.list({ appId: "app_1" })).resolves.toMatchObject({
      ok: true,
      data: { items: [legacyRatio] },
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
