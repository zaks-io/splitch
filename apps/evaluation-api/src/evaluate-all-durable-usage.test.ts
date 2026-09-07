import { describe, expect, it } from "vitest";
import { RecordingPerformanceSpanRecorder } from "./performance-span-test-fixture";
import type { EvaluationCommitEvent } from "./evaluation-commit-sink";
import { CLIENT_KEY, evaluateAllRouteInit, makeSdkRouteHarness } from "./sdk-route-test-fixtures";

describe("POST /api/sdk/evaluate-all: durable usage", () => {
  it("commits batch usage through the Evaluation commit outbox path", async () => {
    const commits: EvaluationCommitEvent[] = [];
    const { app } = await makeSdkRouteHarness({
      evaluationCommitSink: {
        async write(event) {
          commits.push(event);
        },
      },
    });

    const response = await app.request("/api/sdk/evaluate-all", evaluateAllRouteInit(CLIENT_KEY));

    expect(response.status).toBe(200);
    expect(commits).toEqual([
      {
        usage: expect.objectContaining({ evaluationCount: 1, isBatch: true }),
        exposures: [],
      },
    ]);
  });

  it("records identity, resolution, and usage commit spans without request attributes", async () => {
    const spans = new RecordingPerformanceSpanRecorder();
    const { app } = await makeSdkRouteHarness({ spans });

    const response = await app.request("/api/sdk/evaluate-all", evaluateAllRouteInit(CLIENT_KEY));

    expect(response.status).toBe(200);
    expect(spans.records).toEqual([
      {
        descriptor: { name: "Evaluate-all identity admission", op: "auth" },
        attributes: {},
      },
      {
        descriptor: { name: "Evaluate-all resolution", op: "function" },
        attributes: {},
      },
      {
        descriptor: { name: "Evaluate-all usage commit", op: "http.client" },
        attributes: {},
      },
    ]);
  });
});
