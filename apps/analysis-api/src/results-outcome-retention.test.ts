import { describe, expect, it, vi } from "vitest";
import { makeResultsHarness, RESULTS_PATH, resultsAuthInit } from "./results-test-harness";
import { RUN_ID, rowsByPipe } from "./results-test-support";

const DAY_MS = 86_400_000;
const EXPOSED_AT = Date.parse("2026-07-01T00:00:00.000Z");

describe("Results outcome retention", () => {
  it.each([false, true])(
    "refuses expired outcomes even with pinned watermark=%s",
    async (pinned) => {
      vi.setSystemTime(EXPOSED_AT + 92 * DAY_MS);
      const fixture = rowsByPipe();
      // Model the batched LEFT JOIN after Control's day-2 conversions expire,
      // while Treatment's day-10 conversions survive. Sticky Exposures remain.
      fixture.analysis_metric_values_batch = (fixture.analysis_metric_values_batch ?? []).map(
        (row) => {
          const value = row as { targeting_key_hash: string };
          return { ...value, value: value.targeting_key_hash.startsWith("control") ? 0 : 1 };
        },
      );
      const { app } = makeResultsHarness(fixture);
      const response = await app.request(
        RESULTS_PATH,
        resultsAuthInit("POST", {
          runId: RUN_ID,
          ...(pinned ? { dataWatermark: "2026-07-05T00:00:00.000Z" } : {}),
        }),
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        code: "VALIDATION_ERROR",
        details: { issues: [{ message: expect.stringContaining("expire after 90 days") }] },
      });
    },
  );

  it("still analyzes a complete population just inside the physical retention boundary", async () => {
    vi.setSystemTime(EXPOSED_AT + 90 * DAY_MS - 1);
    const { app } = makeResultsHarness();
    const response = await app.request(RESULTS_PATH, resultsAuthInit("GET"));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ state: "ready" });
  });

  it("refuses the TTL boundary, including subsecond Exposure timestamps", async () => {
    const fixture = rowsByPipe();
    fixture.analysis_deduped_exposures = (fixture.analysis_deduped_exposures ?? []).map((row) => ({
      ...(row as object),
      first_exposure_ts: "2026-07-01T00:00:00.999Z",
    }));
    vi.setSystemTime(EXPOSED_AT + 90 * DAY_MS);
    const { app } = makeResultsHarness(fixture);
    const response = await app.request(RESULTS_PATH, resultsAuthInit("GET"));
    expect(response.status).toBe(400);
  });

  it("does not let expired Activation history silently shrink a gated population", async () => {
    vi.setSystemTime(EXPOSED_AT + 92 * DAY_MS);
    const fixture = rowsByPipe();
    const [run] = fixture.analysis_run_inputs ?? [];
    if (!run) throw new Error("missing fixture Run");
    Object.assign(run, { activation_metric_id: "metric_activation" });
    fixture.analysis_activation_rows = [];
    const { app } = makeResultsHarness(fixture);
    const response = await app.request(RESULTS_PATH, resultsAuthInit("GET"));
    expect(response.status).toBe(400);
  });
});
