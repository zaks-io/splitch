import { routeRegistry } from "@splitch/contracts";
import { describe, expect, it } from "vitest";
import { createSplitchClient } from "./client";
import { FakeLogger } from "./test-fixtures";

/**
 * The data-plane half of the SPL-261 contract.
 * `control-plane-sdk/src/idempotency-header.contract.test.ts` covers its own
 * routes and defers this half by name ("Data-plane routes belong to
 * `@splitch/sdk`"), which is how `sdk_evaluate` shipped able to omit the header
 * the route requires: nothing asserted otherwise.
 *
 * `worker-runtime/steps/idempotency.ts` reads the `Idempotency-Key` HEADER and
 * nothing else, so a route declaring `idempotency: "required"` is unusable by a
 * client that omits it. This table is exhaustive BY CONSTRUCTION: the coverage
 * assertion fails when a `required` data-plane route has no probe, so a newly
 * required route cannot ship without a client that proves it sends the header.
 */

const KEY = "idem_contract_probe";
const CONTEXT = { targetingKey: "u1", idempotencyKey: KEY } as const;

/**
 * Each probe drives the PUBLIC client and may issue several requests: the
 * cache-hit telemetry route is only reachable behind a resolved Evaluation.
 * The assertion filters by route path, so a probe never has to name which of
 * its own requests to check.
 */
const probes: Record<string, (client: SplitchClient) => Promise<unknown>> = {
  sdk_evaluate: (client) => client.evaluateDetails("new-checkout", CONTEXT),
  sdk_evaluate_all: (client) => client.evaluateAll(CONTEXT),
  // First call resolves and fills the seen-set; the second replays that entry
  // and reports the suppressed Evaluation to the telemetry route.
  sdk_cached_evaluation_telemetry: async (client) => {
    await client.evaluateDetails("new-checkout", CONTEXT);
    return client.evaluateDetails("new-checkout", CONTEXT);
  },
};

type SplitchClient = ReturnType<typeof createSplitchClient>;

const requiredDataPlaneOperations = routeRegistry
  .filter((route) => route.idempotency === "required" && route.owner === "evaluation-api")
  .map((route) => route.operationId);

const pathByOperation = new Map(routeRegistry.map((route) => [route.operationId, route.path]));

describe("data plane sdk idempotency header contract", () => {
  it("probes every required-idempotency data-plane route", () => {
    const unprobed = requiredDataPlaneOperations.filter((id) => !(id in probes));
    expect(
      unprobed,
      `these routes declare idempotency: "required" but no SDK probe proves the client sends the Idempotency-Key header`,
    ).toEqual([]);
  });

  it.each(requiredDataPlaneOperations)("%s sends the Idempotency-Key header", async (id) => {
    const probe = probes[id];
    if (!probe) throw new Error(`no probe for "${id}"`);
    const path = pathByOperation.get(id);

    const requests = await captureRequests(probe);
    const onRoute = requests.filter((request) => new URL(request.url).pathname === path);

    expect(onRoute.length, `the probe issued no request to ${path}`).toBeGreaterThan(0);
    for (const request of onRoute) {
      expect(request.headers.get("idempotency-key")).toBe(KEY);
    }
  });
});

async function captureRequests(probe: (client: SplitchClient) => Promise<unknown>) {
  const requests: Request[] = [];
  const capturingFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push(new Request(input as RequestInfo, init));
    return okResponse(new URL(String(input)).pathname);
  }) as typeof fetch;

  await probe(
    createSplitchClient({
      apiKey: "sk_test",
      endpoint: "https://edge.test",
      fetch: capturingFetch,
      logger: new FakeLogger(),
    }),
  );
  return requests;
}

/**
 * A 200 per route, because the telemetry probe only reaches its route when the
 * evaluation ahead of it resolved and cached. `x-run-id` is what the seen-set
 * keys on, so without it the second evaluate would miss and never report.
 */
function okResponse(pathname: string): Response {
  if (pathname === "/api/sdk/evaluate-all") {
    return new Response(JSON.stringify({ evaluations: {} }), { headers: { etag: '"tag-1"' } });
  }
  return new Response(JSON.stringify({ variant: true, variantName: "treatment" }), {
    headers: { "x-run-id": "run_probe", "x-variant-name": "treatment", "x-reason": "SPLIT" },
  });
}
