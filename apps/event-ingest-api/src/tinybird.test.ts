import { afterEach, describe, expect, it, vi } from "vitest";
import { EvaluationEntrypoint } from "./index";
import {
  appId,
  baseExposure,
  environmentId,
  makeEnv,
  mockTinybirdFetch,
  TestExecutionContext,
  workerRequest,
} from "./test-fixtures";
import { tinybirdDelivery } from "./tinybird";
import type { Env } from "./types";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("tinybirdDelivery", () => {
  it("fails closed when TINYBIRD_API_URL is missing instead of using Tinybird's generic default", () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const delivery = tinybirdDelivery({
      TINYBIRD_INGEST_TOKEN: "tb_ingest_secret",
    } as Env);

    expect(delivery.ok).toBe(false);
    if (delivery.ok) throw new Error("expected Tinybird delivery to fail closed");
    expect(delivery.error).toMatchObject({
      code: "SERVICE_UNAVAILABLE",
      message: "Tinybird API URL is unavailable",
    });
    expect(JSON.stringify(delivery)).not.toContain("api.tinybird.co");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("uses the configured URL for explicit local fixtures", () => {
    const delivery = tinybirdDelivery({
      TINYBIRD_API_URL: "https://tinybird.test",
      TINYBIRD_INGEST_TOKEN: "tb_ingest_secret",
    } as Env);

    expect(delivery).toEqual({
      ok: true,
      value: {
        url: "https://tinybird.test/v0/events?name=raw_events",
        token: "tb_ingest_secret",
      },
    });
  });

  it("does not send a request to Tinybird's generic default when TINYBIRD_API_URL is absent", async () => {
    const fetch = mockTinybirdFetch();
    const env = { ...makeEnv(), TINYBIRD_API_URL: undefined };
    const ctx = new TestExecutionContext();
    const response = await new EvaluationEntrypoint(ctx, env as Env).fetch(
      workerRequest("https://splitch-event-ingest.internal/api/internal/exposures", {
        method: "POST",
        headers: {
          authorization: "Bearer internal_ingest_secret",
          "content-type": "application/json",
          "x-splitch-app-id": appId,
          "x-splitch-environment-id": environmentId,
        },
        body: JSON.stringify(baseExposure()),
      }),
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      code: "SERVICE_UNAVAILABLE",
      message: "Tinybird API URL is unavailable",
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(fetch.mock.calls.map(([url]) => String(url)).join()).not.toContain("api.tinybird.co");
  });

  it("still fails when the ingest token is missing", () => {
    const delivery = tinybirdDelivery({
      TINYBIRD_API_URL: "https://tinybird.test",
    } as Env);

    expect(delivery.ok).toBe(false);
    if (delivery.ok) throw new Error("expected Tinybird delivery to fail closed");
    expect(delivery.error).toMatchObject({
      code: "SERVICE_UNAVAILABLE",
      message: "Tinybird ingest token is unavailable",
    });
  });
});
