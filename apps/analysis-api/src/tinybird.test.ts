import { describe, expect, it } from "vitest";
import type {
  PerformanceSpanAttribute,
  PerformanceSpanDescriptor,
  PerformanceSpanRecorder,
} from "@splitch/observability/performance-spans";
import {
  createTinybirdCopyTransport,
  createTinybirdReadTransport,
  scopedUsagePipeParams,
  TinybirdCopyError,
  TinybirdReadError,
  tinybirdDateTime64,
} from "./tinybird";

describe("Tinybird observability", () => {
  it("records the pipe, HTTP outcome, and row count without query parameters", async () => {
    const recorded: Array<{
      descriptor: PerformanceSpanDescriptor;
      attributes: Record<string, PerformanceSpanAttribute>;
    }> = [];
    const spanRecorder: PerformanceSpanRecorder = {
      async record(descriptor, run) {
        const attributes = { ...descriptor.attributes };
        recorded.push({ descriptor, attributes });
        return run({
          setAttribute(key, value) {
            attributes[key] = value;
          },
          setAttributes(values) {
            Object.assign(attributes, values);
          },
        });
      },
    };
    const transport = createTinybirdReadTransport(
      {
        TINYBIRD_API_URL: "https://tinybird.test",
        TINYBIRD_READ_TOKEN: "test-token",
      },
      {
        spanRecorder,
        fetchFn: async () => Response.json({ data: [{ run_id: "run_1" }] }),
      },
    );

    await transport.readPipe("analysis_run_inputs", {
      app_id: "app_secret",
      environment_id: "env_secret",
    });

    expect(recorded).toEqual([
      {
        descriptor: expect.objectContaining({
          name: "Tinybird read analysis_run_inputs",
          op: "http.client",
        }),
        attributes: {
          "db.system": "tinybird",
          "db.operation.name": "read",
          "http.request.method": "GET",
          "tinybird.pipe.name": "analysis_run_inputs",
          "http.response.status_code": 200,
          "db.response.returned_rows": 1,
        },
      },
    ]);
    expect(JSON.stringify(recorded)).not.toContain("app_secret");
    expect(JSON.stringify(recorded)).not.toContain("env_secret");
  });
});

describe("Tinybird read transport", () => {
  it("requires the full Organization usage scope at the read chokepoint", async () => {
    const transport = createTinybirdReadTransport({
      TINYBIRD_API_URL: "https://tinybird.test",
      TINYBIRD_READ_TOKEN: "test-token",
    });

    await expect(
      transport.readPipe("analysis_evaluation_usage", { organization_id: "org_1" }),
    ).rejects.toThrow(/period_start/);
  });

  it("rejects mixed Organization and App scopes at the read chokepoint", async () => {
    const transport = createTinybirdReadTransport({
      TINYBIRD_API_URL: "https://tinybird.test",
      TINYBIRD_READ_TOKEN: "test-token",
    });

    await expect(
      transport.readPipe("analysis_evaluation_usage", {
        organization_id: "org_1",
        period_start: "2026-07-01T00:00:00.000Z",
        period_end: "2026-08-01T00:00:00.000Z",
        app_id: "app_1",
      }),
    ).rejects.toThrow(/cannot mix/);
  });

  it("requires app_id and environment_id at the read chokepoint", async () => {
    const transport = createTinybirdReadTransport({
      TINYBIRD_API_URL: "https://tinybird.test",
      TINYBIRD_READ_TOKEN: "test-token",
    });

    await expect(transport.readPipe("analysis_run_inputs", { app_id: "app_1" })).rejects.toThrow(
      /environment_id/,
    );
  });

  it("maps Tinybird fetch timeouts to TinybirdReadError", async () => {
    const transport = createTinybirdReadTransport(
      {
        TINYBIRD_API_URL: "https://tinybird.test",
        TINYBIRD_READ_TOKEN: "test-token",
      },
      {
        fetchFn: async (_input, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
          }),
        timeoutMs: 1,
      },
    );

    await expect(
      transport.readPipe("analysis_run_inputs", {
        app_id: "app_1",
        environment_id: "env_prod",
      }),
    ).rejects.toBeInstanceOf(TinybirdReadError);
  });

  it("returns Tinybird data from a scoped pipe read", async () => {
    let calledSearch = new URLSearchParams();
    const transport = createTinybirdReadTransport(
      {
        TINYBIRD_API_URL: "https://tinybird.test",
        TINYBIRD_READ_TOKEN: "test-token",
      },
      {
        fetchFn: async (input) => {
          calledSearch = new URL(String(input)).searchParams;
          return Response.json({ data: [{ run_id: "run_1" }] });
        },
      },
    );

    const rows = await transport.readPipe("analysis_run_inputs", {
      app_id: "app_1",
      environment_id: "env_prod",
      experiment_id: "exp_1",
    });

    expect(rows).toEqual([{ run_id: "run_1" }]);
    expect(calledSearch.get("app_id")).toBe("app_1");
    expect(calledSearch.get("environment_id")).toBe("env_prod");
  });

  it("posts large pipe parameters in the request body", async () => {
    let calledUrl = new URL("https://tinybird.test");
    let calledMethod: string | undefined;
    let calledBody = new URLSearchParams();
    const transport = createTinybirdReadTransport(
      {
        TINYBIRD_API_URL: "https://tinybird.test",
        TINYBIRD_READ_TOKEN: "test-token",
      },
      {
        fetchFn: async (input, init) => {
          calledUrl = new URL(String(input));
          calledMethod = init?.method;
          calledBody = new URLSearchParams(String(init?.body));
          return Response.json({ data: [] });
        },
      },
    );

    await transport.readPipe(
      "analysis_metric_values_batch",
      {
        app_id: "app_1",
        environment_id: "env_prod",
        metric_query_config: '[{"metric_id":"metric_1"}]',
      },
      { method: "POST" },
    );

    expect(calledUrl.search).toBe("");
    expect(calledMethod).toBe("POST");
    expect(calledBody.get("app_id")).toBe("app_1");
    expect(calledBody.get("metric_query_config")).toBe('[{"metric_id":"metric_1"}]');
  });

  it("builds the Organization usage scope without accepting a caller-selected app", () => {
    expect(
      scopedUsagePipeParams({
        organizationId: "org_1",
        periodStart: "2026-07-01T00:00:00.000Z",
        periodEnd: "2026-08-01T00:00:00.000Z",
      }),
    ).toEqual({
      organization_id: "org_1",
      period_start: "2026-07-01 00:00:00.000",
      period_end: "2026-08-01 00:00:00.000",
    });
  });

  it("carries period parameters in the DateTime64 form Tinybird accepts, never ISO 8601", () => {
    // The ISO form deployed once and every production usage read 400ed with
    // TYPE_MISMATCH, rendered to callers as 503 "usage data is unavailable".
    const params = scopedUsagePipeParams({
      organizationId: "org_1",
      periodStart: "2026-08-01T00:00:00.000Z",
      periodEnd: "2026-09-01T00:00:00.000Z",
    });
    expect(params.period_start).not.toContain("T");
    expect(params.period_start).not.toContain("Z");
    expect(tinybirdDateTime64("2026-08-01T00:00:00.000Z")).toBe("2026-08-01 00:00:00.000");
    expect(() => tinybirdDateTime64("not-a-timestamp")).toThrow(/DateTime64/);
  });
});

describe("Tinybird Copy Pipe transport", () => {
  it("posts Copy Pipe runs with copy-token auth and query parameters", async () => {
    let calledUrl = new URL("https://tinybird.test");
    let calledMethod: string | undefined;
    let calledAuth: string | undefined;
    const transport = createTinybirdCopyTransport(
      {
        TINYBIRD_API_URL: "https://tinybird.test",
        TINYBIRD_COPY_TOKEN: "copy-token",
      },
      {
        fetchFn: async (input, init) => {
          calledUrl = new URL(String(input));
          calledMethod = init?.method;
          calledAuth =
            init?.headers instanceof Headers
              ? (init.headers.get("authorization") ?? undefined)
              : (init?.headers as Record<string, string> | undefined)?.authorization;
          return Response.json({ job: { id: "job_1" } });
        },
      },
    );

    await transport.runCopyPipe("cp_deduped_exposures", {
      _mode: "replace",
      copy_watermark_ts: "2026-07-03 21:00:00.123",
    });

    expect(calledUrl.pathname).toBe("/v0/pipes/cp_deduped_exposures/copy");
    expect(calledUrl.searchParams.get("_mode")).toBe("replace");
    expect(calledUrl.searchParams.get("copy_watermark_ts")).toBe("2026-07-03 21:00:00.123");
    expect(calledMethod).toBe("POST");
    expect(calledAuth).toBe("Bearer copy-token");
  });

  it("requires a dedicated copy token", async () => {
    const transport = createTinybirdCopyTransport({
      TINYBIRD_API_URL: "https://tinybird.test",
      TINYBIRD_READ_TOKEN: "read-token",
    });

    await expect(transport.runCopyPipe("cp_deduped_exposures", {})).rejects.toBeInstanceOf(
      TinybirdCopyError,
    );
  });
});
