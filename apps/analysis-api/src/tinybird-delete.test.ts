import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  APP_IDENTITY_RESET_DATASOURCES,
  deleteAppIdentityData,
} from "./tinybird-app-identity-reset";
import { createTinybirdDeleteTransport, TinybirdDeleteError } from "./tinybird-delete";

const API_URL = "https://api.us-west-2.aws.tinybird.co";

describe("Tinybird App identity reset", () => {
  it("suppresses the App, proves every store empty, then removes the suppression last", async () => {
    let proofQueryCount = 0;
    const fetchFn = vi.fn<typeof fetch>(
      appResetFetch((query) => {
        proofQueryCount += 1;
        const visibleWholeAppSuppression =
          query.includes("FROM environment_exposure_status_deletions") &&
          query.includes("environment_id = ''") &&
          proofQueryCount === 1;
        return visibleWholeAppSuppression ? 1 : 0;
      }),
    );

    const proof = await deleteAppIdentityData(
      { TINYBIRD_API_URL: API_URL, TINYBIRD_DELETE_TOKEN: "delete-token" },
      "app_1",
      { fetchFn },
    );

    expect(proof).toContain("suppression=visible,audit_log=retained");
    expect(proof).toContain("status-stable=0");
    for (const datasource of APP_IDENTITY_RESET_DATASOURCES) {
      expect(proof).toContain(`${datasource}=0`);
    }
    const deleteCalls = fetchFn.mock.calls.filter(([input]) =>
      new URL(String(input)).pathname.endsWith("/delete"),
    );
    expect(deleteCalls.map(([input]) => new URL(String(input)).pathname)).toEqual(
      APP_IDENTITY_RESET_DATASOURCES.map((name) => `/v0/datasources/${name}/delete`),
    );
    expect(new URL(String(fetchFn.mock.calls[0]?.[0])).pathname).toBe("/v0/events");
    expect(new URL(String(deleteCalls.at(-1)?.[0])).pathname).toBe(
      "/v0/datasources/environment_exposure_status_deletions/delete",
    );
    for (const [, init] of deleteCalls) {
      expect(String(init?.body)).toBe("delete_condition=app_id+%3D+%27app_1%27");
    }
    const stateProofs = fetchFn.mock.calls.filter(([input]) => {
      const url = new URL(String(input));
      return (
        url.pathname === "/v0/sql" &&
        url.searchParams.get("q")?.includes("FROM environment_exposure_status_state")
      );
    });
    expect(stateProofs).toHaveLength(2);
  });

  it("fails closed when deletion completion leaves rows behind", async () => {
    const fetchFn = vi.fn<typeof fetch>(
      appResetFetch((query) => (query.includes("environment_id = ''") ? 1 : 2)),
    );

    await expect(
      deleteAppIdentityData(
        { TINYBIRD_API_URL: API_URL, TINYBIRD_DELETE_TOKEN: "delete-token" },
        "app_1",
        { fetchFn },
      ),
    ).rejects.toThrow("remaining_rows=2");
    const deleteCalls = fetchFn.mock.calls.filter(([input]) =>
      new URL(String(input)).pathname.endsWith("/delete"),
    );
    expect(deleteCalls).toHaveLength(1);
    expect(String(deleteCalls[0]?.[0])).toContain("raw_events/delete");
    expect(
      deleteCalls.some(([input]) =>
        String(input).includes("environment_exposure_status_deletions/delete"),
      ),
    ).toBe(false);
  });

  it("fails before deletion when the whole-App suppression is not visible", async () => {
    const fetchFn = vi.fn<typeof fetch>(appResetFetch(() => 0));

    await expect(
      deleteAppIdentityData(
        { TINYBIRD_API_URL: API_URL, TINYBIRD_DELETE_TOKEN: "delete-token" },
        "app_1",
        { fetchFn },
      ),
    ).rejects.toThrow("environment_exposure_status_deletions");
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("uses authenticated zero-row queries rather than trusting completed jobs", async () => {
    const fetchFn = vi.fn<typeof fetch>(
      appResetFetch((query) => (query.includes("environment_id = ''") ? 1 : 0)),
    );

    await deleteAppIdentityData(
      { TINYBIRD_API_URL: API_URL, TINYBIRD_DELETE_TOKEN: "delete-token" },
      "app_1",
      { fetchFn },
    );
    const proofCalls = fetchFn.mock.calls.filter(
      ([input]) => new URL(String(input)).pathname === "/v0/sql",
    );
    expect(proofCalls).toHaveLength(APP_IDENTITY_RESET_DATASOURCES.length + 2);
    for (const [input, init] of proofCalls) {
      expect(new URL(String(input)).searchParams.get("q")).toContain("app_id = 'app_1'");
      expect(init?.headers).toEqual({ authorization: "Bearer delete-token" });
    }
  });

  it("matches every App-scoped Tinybird store while preserving the legal audit log", () => {
    const datasourceDir = resolve(import.meta.dirname, "../../../infra/tinybird/datasources");
    const appScoped = readdirSync(datasourceDir)
      .filter((name) => name.endsWith(".datasource"))
      .filter((name) => readFileSync(resolve(datasourceDir, name), "utf8").includes("`app_id`"))
      .map((name) => name.replace(/\.datasource$/u, ""))
      .sort();

    expect([...APP_IDENTITY_RESET_DATASOURCES].sort()).toEqual(
      appScoped.filter((name) => name !== "audit_log"),
    );
    expect(APP_IDENTITY_RESET_DATASOURCES).not.toContain("audit_log");
    expect(
      readFileSync(
        resolve(import.meta.dirname, "../../../infra/tinybird/pipes/analysis_run_inputs.pipe"),
        "utf8",
      ),
    ).toContain("FROM run_snapshots");
  });
});

function appResetFetch(rowCount: (query: string) => number): typeof fetch {
  return async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/v0/events") {
      return Response.json({ successful_rows: 1, quarantined_rows: 0 });
    }
    if (url.pathname === "/v0/sql") {
      return Response.json({
        data: [{ remaining_rows: rowCount(url.searchParams.get("q") ?? "") }],
      });
    }
    return Response.json({ status: "done" });
  };
}

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

describe("Tinybird Entity privacy deletion", () => {
  it("commits every retained-hash cutoff before deleting all raw and derived stores", async () => {
    const hashA = `v1:${"a".repeat(64)}`;
    const hashB = `app-v1:${"b".repeat(64)}`;
    const fetchFn = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/v0/events") {
        return Response.json({ successful_rows: 2, quarantined_rows: 0 });
      }
      return Response.json({ status: "done" });
    });
    const transport = createTinybirdDeleteTransport(
      { TINYBIRD_API_URL: API_URL, TINYBIRD_DELETE_TOKEN: "delete-token" },
      { fetchFn },
    );
    const scope = {
      appId: "app_1",
      idType: "user",
      targetingKeyHashes: [hashA, hashB],
      entityFamilyHash: hashA,
      deleteBeforeTs: "2026-08-28T12:00:00.000Z",
    };

    const suppression = await transport.suppressEntity?.(scope);
    const proofs = await transport.deleteEntity?.(scope);

    expect(suppression).toEqual(["entity_deletions:successful_rows=2"]);
    expect(proofs).toEqual([
      "tinybird:raw_events:done",
      "tinybird:metric_events:done",
      "tinybird:deduped_exposures:done",
      "tinybird:deduped_metric_events_state:done",
    ]);
    const suppressionCall = fetchFn.mock.calls[0];
    expect(String(suppressionCall?.[0])).toBe(
      `${API_URL}/v0/events?name=entity_deletions&wait=true`,
    );
    expect(String(suppressionCall?.[1]?.body)).not.toContain("targetingKey");
    expect(fetchFn).toHaveBeenCalledTimes(5);
  });
});
