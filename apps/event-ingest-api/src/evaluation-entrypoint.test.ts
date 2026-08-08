import { __setSentryModuleForTests } from "@splitch/observability/worker";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EvaluationEntrypoint } from "./index";
import {
  makeMetricEventFixture,
  metricEventBody,
  sendMetricEvent,
} from "./metric-event.test-fixture";
import {
  appId,
  baseExposure,
  environmentId,
  experimentId,
  fixedNow,
  liveRunId,
  makeEnv,
  mockTinybirdFetch,
  organizationId,
  TestExecutionContext,
} from "./test-fixtures";
import type { Env } from "./types";

type SentryModule = NonNullable<Parameters<typeof __setSentryModuleForTests>[0]>;

afterEach(() => {
  __setSentryModuleForTests(undefined);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/**
 * `EVENT_INGEST` is one binding carrying every operation the Evaluation Worker
 * delegates. Each of these drives the real entrypoint and asserts the handler on
 * the far side answered, because a config assertion cannot tell a recognised
 * operation from one the entrypoint refuses.
 */
describe("Evaluation binding entrypoint", () => {
  it("reaches the Exposure ingest handler", async () => {
    const { response, fetch } = await internal("/api/internal/exposures", baseExposure());

    expect(response.status).toBe(202);
    expect(fetch.mock.calls[0]?.[0]).toBe("https://tinybird.test/v0/events?name=raw_events");
  });

  it("reaches the Evaluation usage handler", async () => {
    const { response, fetch } = await internal("/api/internal/evaluations", usagePayload());

    expect(response.status).toBe(202);
    expect(fetch.mock.calls[0]?.[0]).toBe("https://tinybird.test/v0/events?name=raw_evaluations");
  });

  it("reaches the Evaluation commit handler", async () => {
    const { response, fetch } = await internal("/api/internal/evaluation-commits", {
      ...usagePayload(),
      exposures: [baseExposure()],
    });

    expect(response.status).toBe(202);
    expect(fetch).toHaveBeenCalled();
  });

  it("reaches the Metric Event handler", async () => {
    const fixture = await makeMetricEventFixture();

    const response = await sendMetricEvent(fixture, metricEventBody());

    expect(response.status).toBe(202);
    expect(fixture.claims.size).toBe(1);
  });

  it("reports an unhandled throw through the Sentry capture seam", async () => {
    const captured: unknown[] = [];
    __setSentryModuleForTests(fakeSentry(captured));
    // No privacy salt outside a local target: the targeting-key HMAC throws, and
    // this is the only public ingest path, so the throw has to be observable.
    const fixture = await makeMetricEventFixture({
      SPLITCH_PLATFORM_TARGET: "production",
      SENTRY_DSN: "https://public@sentry.test/1",
    });

    await expect(sendMetricEvent(fixture, metricEventBody())).rejects.toThrow(
      "EVALUATION_PRIVACY_SALT is required outside local targets",
    );
    expect(captured).toHaveLength(1);
  });
});

async function internal(path: string, body: unknown) {
  vi.spyOn(Date, "now").mockReturnValue(new Date(fixedNow).getTime());
  const fetch = mockTinybirdFetch();
  const ctx = new TestExecutionContext();
  const env = makeEnv() as Env;
  const response = await new EvaluationEntrypoint(ctx, env).fetch(
    new Request(`https://splitch-event-ingest.internal${path}`, {
      method: "POST",
      headers: {
        authorization: "Bearer internal_ingest_secret",
        "content-type": "application/json",
        "x-splitch-app-id": appId,
        "x-splitch-environment-id": environmentId,
        "x-splitch-organization-id": organizationId,
      },
      body: JSON.stringify(body),
    }),
  );
  await Promise.all(ctx.waits);
  return { response, fetch };
}

function usagePayload() {
  return {
    evaluationCount: 1,
    isBatch: false,
    isCached: false,
    hasExposure: false,
    flagKey: "checkout",
    sdkRuntime: "javascript",
    idempotencyKey: "eval-request-1",
    experimentId,
    runId: liveRunId,
  };
}

/** Stands in for `withSentry`, which is the only place an escaping throw is seen. */
function fakeSentry(captured: unknown[]) {
  return {
    withSentry(
      _options: unknown,
      handler: { fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> },
    ) {
      return {
        async fetch(request: Request, env: Env, ctx: ExecutionContext) {
          try {
            return await handler.fetch(request, env, ctx);
          } catch (error) {
            captured.push(error);
            throw error;
          }
        },
      };
    },
    captureMessage: vi.fn(),
  } as unknown as SentryModule;
}
