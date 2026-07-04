import { describe, expect, it } from "vitest";
import {
  createTinybirdCopyTransport,
  createTinybirdReadTransport,
  TinybirdCopyError,
  TinybirdReadError,
} from "./tinybird";

describe("Tinybird read transport", () => {
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
