import { ScopedAnalysisError } from "@splitch/control-plane-sdk/panel-experiments";
import { describe, expect, it } from "vitest";
import { panelAnalysisFailureResponse } from "./panel-analysis-failure";

describe("panelAnalysisFailureResponse", () => {
  it("reports a Run-provenance mismatch as permanent, with nothing to retry on", async () => {
    const response = panelAnalysisFailureResponse(
      new ScopedAnalysisError(500, "scoped analysis answered for Run run_other, not Run run_mine"),
    );

    expect(response.status).toBe(500);
    const body = (await response.json()) as { code: string; details: Record<string, unknown> };
    expect(body.code).toBe("INTERNAL_SERVER_ERROR");
    expect(body.details).not.toHaveProperty("retryAfterMs");
  });

  it("keeps a genuinely transient analysis failure retryable", async () => {
    const response = panelAnalysisFailureResponse(new ScopedAnalysisError(503, "upstream down"));

    expect(response.status).toBe(503);
    const body = (await response.json()) as { code: string; details: { retryAfterMs: number } };
    expect(body.code).toBe("SERVICE_UNAVAILABLE");
    expect(body.details.retryAfterMs).toBe(30_000);
  });

  // An unknown fault is not evidence of a permanent one, so it keeps the
  // conservative retryable shape the Panel already handles.
  it("treats an unrecognised failure as transient", async () => {
    const response = panelAnalysisFailureResponse(new Error("boom"));

    expect(response.status).toBe(503);
  });
});
