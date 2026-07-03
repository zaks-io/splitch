import { describe, expect, it } from "vitest";
import { createTinybirdReadTransport, TinybirdReadError } from "./tinybird.js";

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
