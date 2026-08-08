import { routesDelegatedBy } from "@splitch/contracts";
import { __setSentryModuleForTests } from "@splitch/observability/worker";
import { delegatedRequest } from "@splitch/worker-runtime";
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

const NOT_DELEGATED = "delegated request was not recognized by its owner";

/**
 * Deliberately not read off `internalRoutes`: the point of the sweep below is to
 * be an oracle the routing table cannot move. These three are the sinks
 * `apps/evaluation-api` builds URLs for; the rest come from the route registry.
 */
const INTERNAL_SINK_PATHS = [
  "/api/internal/exposures",
  "/api/internal/evaluations",
  "/api/internal/evaluation-commits",
];

/** Every operation the single EVENT_INGEST binding carries, as a callable request. */
const DELEGATED_OPERATIONS: Array<[string, () => Request]> = [
  ...INTERNAL_SINK_PATHS.map((path): [string, () => Request] => [
    path,
    () => new Request(`https://splitch-event-ingest.internal${path}`, { method: "POST" }),
  ]),
  ...routesDelegatedBy("evaluation-api")
    .filter((route) => route.owner === "event-ingest-api")
    .map((route): [string, () => Request] => [
      route.path,
      () =>
        delegatedRequest(
          route,
          {
            operation: route.id,
            actorId: "client_key:sweep",
            orgId: organizationId,
            appId,
            environmentId,
          },
          { body: {} },
        ),
    ]),
];

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
    // The sealed pair, in order: only this handler appends the Exposure beside
    // the usage row, so the second call is what tells it apart from its sibling.
    expect(fetch.mock.calls[0]?.[0]).toBe("https://tinybird.test/v0/events?name=raw_evaluations");
    expect(fetch.mock.calls[1]?.[0]).toBe("https://tinybird.test/v0/events?name=raw_events");
  });

  it("reaches the Metric Event handler", async () => {
    const fixture = await makeMetricEventFixture();

    const response = await sendMetricEvent(fixture, metricEventBody());

    expect(response.status).toBe(202);
    expect(fixture.claims.size).toBe(1);
  });

  it("reaches the Metric Event handler with an API Key", async () => {
    const fixture = await makeMetricEventFixture({}, "api_key");

    const response = await sendMetricEvent(fixture, metricEventBody());

    expect(response.status).toBe(202);
    expect(fixture.claims.size).toBe(1);
  });

  /**
   * The four cases above name their operations by hand; this one sweeps the whole
   * delegated set and grows with the route registry. It asks only whether the
   * entrypoint recognises the address, so a bad body answering 4xx passes and the
   * refusal is the sole failure, because that refusal is what a missed operation
   * looks like in production.
   */
  it.each(DELEGATED_OPERATIONS)("recognises %s over the binding", async (path, build) => {
    const response = await new EvaluationEntrypoint(new TestExecutionContext(), makeEnv() as Env)
      .fetch(build())
      .catch(() => new Response("threw", { status: 599 }));

    expect(await response.text(), `${path} is not routed by EvaluationEntrypoint`).not.toContain(
      NOT_DELEGATED,
    );
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
