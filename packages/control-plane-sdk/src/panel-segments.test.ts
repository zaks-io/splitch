import { describe, expect, it, vi } from "vitest";
import { createPanelSegmentsClient } from "./panel-segments";

describe("panel Segments list envelope", () => {
  it("reads Segment choices and their affected Environments from the canonical route", async () => {
    let request: Request | undefined;
    const client = createPanelSegmentsClient({
      fetch: async (input) => {
        request = input instanceof Request ? input : new Request(input);
        return Response.json({
          items: [
            {
              id: "segment_paid",
              appId: "app_1",
              name: "Paid plan",
              conditions: [{ attribute: "plan", operator: "eq", value: "paid" }],
              createdAt: "2026-08-07T00:00:00.000Z",
              updatedAt: "2026-08-07T00:00:00.000Z",
              affectedEnvironmentIds: ["env_dev", "env_prod"],
            },
          ],
          readLimit: 200,
          readTruncated: false,
          cursor: null,
        });
      },
    });

    const result = await client.list({ appId: "app_1" });

    expect(request?.url).toBe("https://control-plane.internal/apps/app_1/segments");
    expect(result).toMatchObject({
      ok: true,
      data: {
        items: [{ id: "segment_paid", name: "Paid plan" }],
        affectedEnvironmentIds: { segment_paid: ["env_dev", "env_prod"] },
        readLimit: 200,
        readTruncated: false,
        cursor: null,
      },
    });
  });

  it("fails loud when a listed Segment omits affectedEnvironmentIds", async () => {
    const client = createPanelSegmentsClient({
      fetch: async () =>
        Response.json({
          items: [segment()],
          readLimit: 200,
          readTruncated: false,
          cursor: null,
        }),
    });

    await expect(client.list({ appId: "app_1" })).rejects.toThrow(
      "panel_segments_list returned an invalid response body",
    );
  });
});

describe("panel Segments binding transport", () => {
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
      if (request.method === "GET" && request.url.endsWith("/segments")) {
        return Response.json({
          items: [{ ...segment(), affectedEnvironmentIds: ["env_prod"] }],
          readLimit: 200,
          readTruncated: false,
          cursor: null,
        });
      }
      const body = request.method === "GET" ? {} : ((await request.json()) as object);
      return Response.json({ ...segment(), ...body });
    });
    const client = createPanelSegmentsClient({ fetch: fetcher });

    await expect(client.list({ appId: "app_1" })).resolves.toMatchObject({
      ok: true,
      data: { items: [{ name: "Paid plan" }], unparseable: [] },
    });
    await expect(
      client.create({
        appId: "app_1",
        name: "Paid plan",
        conditions: [{ attribute: "plan", operator: "eq", value: "paid" }],
      }),
    ).resolves.toMatchObject({ ok: true, data: { name: "Paid plan" } });
    await expect(client.get({ appId: "app_1", segmentId: "segment_1" })).resolves.toMatchObject({
      ok: true,
      data: { id: "segment_1" },
    });
    await expect(
      client.update({
        appId: "app_1",
        segmentId: "segment_1",
        name: "Enterprise plan",
      }),
    ).resolves.toMatchObject({ ok: true, data: { name: "Enterprise plan" } });
    await expect(client.delete({ appId: "app_1", segmentId: "segment_1" })).resolves.toMatchObject({
      ok: true,
      data: { deleted: true },
    });

    expect(requests.map(({ method, url }) => [method, url])).toEqual([
      ["GET", "https://control-plane.internal/apps/app_1/segments"],
      ["POST", "https://control-plane.internal/apps/app_1/segments"],
      ["GET", "https://control-plane.internal/apps/app_1/segments/segment_1"],
      ["PATCH", "https://control-plane.internal/apps/app_1/segments/segment_1"],
      ["DELETE", "https://control-plane.internal/apps/app_1/segments/segment_1"],
    ]);
    expect(JSON.parse(requests[1]?.body ?? "{}")).toEqual({
      name: "Paid plan",
      conditions: [{ attribute: "plan", operator: "eq", value: "paid" }],
    });
    expect(JSON.parse(requests[3]?.body ?? "{}")).toEqual({
      name: "Enterprise plan",
    });
  });

  it("keeps parseable Segments and names the unparseable ones without failing the list", async () => {
    const client = createPanelSegmentsClient({
      fetch: vi.fn(async () =>
        Response.json({
          items: [
            { ...segment(), affectedEnvironmentIds: ["env_prod"] },
            {
              id: "segment_poison",
              appId: "app_1",
              name: "Poison",
              conditions: [{ attribute: "plan", operator: "in", value: [null, "paid"] }],
              createdAt: "2026-07-29T00:00:00.000Z",
              updatedAt: "2026-07-29T00:00:00.000Z",
              affectedEnvironmentIds: [],
            },
            {
              id: 42,
              appId: "app_1",
              name: "Numeric id",
              conditions: [{ attribute: "plan", operator: "in", value: [null] }],
              createdAt: "2026-07-29T00:00:00.000Z",
              updatedAt: "2026-07-29T00:00:00.000Z",
              affectedEnvironmentIds: [],
            },
          ],
          readLimit: 200,
          readTruncated: false,
          cursor: null,
        }),
      ),
    });

    await expect(client.list({ appId: "app_1" })).resolves.toMatchObject({
      ok: true,
      data: {
        items: [{ id: "segment_1", name: "Paid plan" }],
        unparseable: [
          {
            id: "segment_poison",
            name: "Poison",
            reason: expect.stringMatching(/conditions|Invalid|null/i),
          },
          {
            id: "42",
            name: "Numeric id",
            reason: expect.stringMatching(/conditions|Invalid|null/i),
          },
        ],
      },
    });
  });

  it("rejects a list body that is not an items array", async () => {
    const client = createPanelSegmentsClient({
      fetch: vi.fn(async () => Response.json({ segments: [] })),
    });

    await expect(client.list({ appId: "app_1" })).rejects.toThrow(
      "panel_segments_list returned an invalid response body",
    );
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
