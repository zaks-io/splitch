import { describe, expect, it, vi } from "vitest";
import {
  createPanelExperimentsClient,
  parseScopedAnalysisIdentity,
  SCOPED_SERVICE_IDENTITY_HEADER,
  scopedAnalysisResultsRequest,
} from "./panel-experiments";

describe("panel experiments binding transport", () => {
  it("parses the typed composite response", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({
        items: [
          {
            id: "exp_1",
            name: "Checkout",
            status: "running",
            flag: { id: "flag_1", name: "Checkout Flag" },
            liveRunId: "run_1",
            health: {
              significanceReached: true,
              srmFiring: false,
              guardrailBreached: false,
            },
          },
        ],
      }),
    );

    const result = await createPanelExperimentsClient({ fetch: fetcher }).list({
      appId: "app_1",
      environmentId: "env_1",
    });

    expect(result).toMatchObject({ ok: true, data: { items: [{ liveRunId: "run_1" }] } });
    expect(String(fetcher.mock.calls[0]?.[0])).toBe(
      "https://control-plane.internal/control-panel/experiments/list",
    );
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ method: "POST" });
  });

  it("binds the downstream identity to the exact operation, resources, and Run", async () => {
    const identity = {
      operation: "experiment_results_post" as const,
      actorId: "user_1",
      appId: "app_1",
      environmentId: "env_1",
      experimentId: "exp_1",
      runId: "run_7",
    };
    const request = scopedAnalysisResultsRequest(identity);

    expect(
      parseScopedAnalysisIdentity(request.headers.get(SCOPED_SERVICE_IDENTITY_HEADER)),
    ).toEqual(identity);
    expect(await request.json()).toEqual({ runId: "run_7" });
    expect(request.headers.get("authorization")).toBeNull();
    expect(request.headers.get("x-splitch-panel-session")).toBeNull();
  });
});
