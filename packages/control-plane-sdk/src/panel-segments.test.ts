import { describe, expect, it } from "vitest";
import { createPanelSegmentsClient } from "./panel-segments";

describe("Panel Segments client", () => {
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
            },
          ],
          affectedEnvironmentIds: { segment_paid: ["env_dev", "env_prod"] },
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
      },
    });
  });

  it("fails loud when the dependency projection is absent", async () => {
    const client = createPanelSegmentsClient({
      fetch: async () => Response.json({ items: [] }),
    });

    await expect(client.list({ appId: "app_1" })).rejects.toThrow(
      "panel_segments_list returned an invalid response body",
    );
  });
});
