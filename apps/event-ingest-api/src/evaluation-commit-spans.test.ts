import type {
  PerformanceSpanDescriptor,
  PerformanceSpanRecorder,
} from "@splitch/observability/performance-spans";
import { scrubSentrySpan } from "@splitch/privacy";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleEvaluationCommit } from "./evaluation-commit";
import { baseExposure, fixedNow, makeEnv } from "./test-fixtures";

afterEach(() => vi.restoreAllMocks());

describe("Evaluation commit spans", () => {
  it("records the ordered new-commit stages with scrubber-safe bounded names", async () => {
    vi.spyOn(Date, "now").mockReturnValue(new Date(fixedNow).getTime());
    const descriptors: PerformanceSpanDescriptor[] = [];
    const response = await handleEvaluationCommit(
      request(),
      makeEnv(),
      recordingSpans(descriptors),
    );

    expect(response.status).toBe(202);
    expect(descriptors).toEqual(
      [
        "scope/input",
        "lookup",
        "admission",
        "inventory",
        "seal",
        "privacy confirmation",
        "activate",
      ].map((stage) => ({
        name: `Evaluation commit ${stage}`,
        op: "event.ingest.evaluation_commit",
      })),
    );
    expect(descriptors.map(({ name, op }) => scrubSentrySpan({ description: name, op }))).toEqual(
      descriptors.map(({ name, op }) => ({ description: name, op })),
    );
  });
});

function recordingSpans(descriptors: PerformanceSpanDescriptor[]): PerformanceSpanRecorder {
  return {
    async record(descriptor, run) {
      descriptors.push(descriptor);
      return run({ setAttribute() {}, setAttributes() {} });
    },
  };
}

function request(): Request {
  return new Request("https://splitch-event-ingest.internal/api/internal/evaluation-commits", {
    method: "POST",
    headers: {
      authorization: "Bearer internal_ingest_secret",
      "content-type": "application/json",
      "x-splitch-app-id": "app_credential",
      "x-splitch-environment-id": "env_prod",
      "x-splitch-organization-id": "org_credential",
    },
    body: JSON.stringify({
      evaluationCount: 1,
      isBatch: false,
      isCached: false,
      hasExposure: true,
      flagKey: "checkout",
      sdkRuntime: "javascript",
      idempotencyKey: "eval-request-1",
      identityVersion: "app-v1",
      exposures: [baseExposure()],
    }),
  });
}
