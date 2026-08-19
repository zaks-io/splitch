import { describe, expect, it, vi } from "vitest";
import { createTinybirdDeleteTransport, TinybirdDeleteError } from "./tinybird-delete";

const API_URL = "https://api.us-west-2.aws.tinybird.co";

describe("Tinybird Environment Exposure status deletion", () => {
  it("deletes one Environment with a scoped SQL condition and waits for completion", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ successful_rows: 1, quarantined_rows: 0 }))
      .mockResolvedValueOnce(
        Response.json({
          status: "waiting",
          job_url: `${API_URL}/v0/jobs/delete_1`,
        }),
      )
      .mockResolvedValueOnce(Response.json({ status: "done" }));
    const transport = createTinybirdDeleteTransport(
      {
        TINYBIRD_API_URL: API_URL,
        TINYBIRD_DELETE_TOKEN: "delete-token",
      },
      { fetchFn, delay: async () => {} },
    );

    await transport.deleteExposureStatus({ appId: "app_1", environmentId: "env_prod" });

    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(String(fetchFn.mock.calls[0]?.[0])).toBe(
      `${API_URL}/v0/events?name=environment_exposure_status_deletions&wait=true`,
    );
    expect(fetchFn.mock.calls[0]?.[1]?.body).toBe(
      JSON.stringify({ app_id: "app_1", environment_id: "env_prod" }),
    );
    expect(String(fetchFn.mock.calls[1]?.[0])).toBe(
      `${API_URL}/v0/datasources/environment_exposure_status_state/delete`,
    );
    expect(String(fetchFn.mock.calls[1]?.[1]?.body)).toBe(
      "delete_condition=app_id+%3D+%27app_1%27+AND+environment_id+%3D+%27env_prod%27",
    );
    expect(fetchFn.mock.calls[1]?.[1]?.headers).toEqual({
      authorization: "Bearer delete-token",
    });
  });

  it("deletes every Environment state row for an App in one job", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ successful_rows: 1, quarantined_rows: 0 }))
      .mockResolvedValueOnce(Response.json({ status: "done" }));
    const transport = createTinybirdDeleteTransport(
      { TINYBIRD_API_URL: API_URL, TINYBIRD_DELETE_TOKEN: "delete-token" },
      { fetchFn },
    );

    await transport.deleteExposureStatus({ appId: "app_1" });

    expect(fetchFn.mock.calls[0]?.[1]?.body).toBe(
      JSON.stringify({ app_id: "app_1", environment_id: "" }),
    );
    expect(String(fetchFn.mock.calls[1]?.[1]?.body)).toBe(
      "delete_condition=app_id+%3D+%27app_1%27",
    );
  });

  it("fails loud for missing credentials, unsafe conditions, and failed jobs", async () => {
    await expect(
      createTinybirdDeleteTransport({ TINYBIRD_API_URL: API_URL }).deleteExposureStatus({
        appId: "app_1",
      }),
    ).rejects.toThrow("TINYBIRD_DELETE_TOKEN");

    await expect(
      createTinybirdDeleteTransport({
        TINYBIRD_API_URL: API_URL,
        TINYBIRD_DELETE_TOKEN: "delete-token",
      }).deleteExposureStatus({ appId: "app_1' OR 1=1" }),
    ).rejects.toBeInstanceOf(TinybirdDeleteError);

    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ successful_rows: 1, quarantined_rows: 0 }))
      .mockResolvedValueOnce(Response.json({ status: "failed" }));
    await expect(
      createTinybirdDeleteTransport(
        { TINYBIRD_API_URL: API_URL, TINYBIRD_DELETE_TOKEN: "delete-token" },
        { fetchFn },
      ).deleteExposureStatus({ appId: "app_1" }),
    ).rejects.toThrow("job failed");
  });

  it.each([
    ["queued", new Response(null, { status: 202 })],
    ["quarantined", Response.json({ successful_rows: 0, quarantined_rows: 1 })],
    ["malformed", Response.json({ successful_rows: 1 })],
  ])("does not delete status after a %s suppression acknowledgement", async (_name, response) => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(response);

    await expect(
      createTinybirdDeleteTransport(
        { TINYBIRD_API_URL: API_URL, TINYBIRD_DELETE_TOKEN: "delete-token" },
        { fetchFn },
      ).deleteExposureStatus({ appId: "app_1", environmentId: "env_prod" }),
    ).rejects.toBeInstanceOf(TinybirdDeleteError);

    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});
