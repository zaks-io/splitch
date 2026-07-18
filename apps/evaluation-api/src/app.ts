import type { AuthResolver, RateLimiter, RegistrarDeps } from "@splitch/worker-runtime";
import { createRegistrar } from "@splitch/worker-runtime";
import { Hono } from "hono";
import { makeCachedEvaluationTelemetryHandler } from "./cached-evaluation-telemetry";
import { makeApiKeyOnlyAuthResolver, makeClientKeyOnlyAuthResolver } from "./data-plane-auth";
import { makeEvaluateHandler } from "./evaluate";
import type { EvaluatePathDeps } from "./evaluate/evaluate-path";
import type { ExposureAssemblyDeps } from "./evaluate/exposure-assembly";
import type { EvaluationUsageSink } from "./evaluation-usage-sink";
import type { ExposureSink } from "./exposure-sink";
import { makePeekHandler } from "./peek";
import { evaluationRoute } from "./routes";
import { makeTestEvaluationHandler } from "./test-evaluation";
import { makeVerifyHandler } from "./verify";

export interface AppDeps extends EvaluatePathDeps {
  authResolver: AuthResolver;
  dataPlaneAuthResolver: AuthResolver;
  exposureAssembly: ExposureAssemblyDeps;
  exposureSink: ExposureSink;
  evaluationUsageSink: EvaluationUsageSink;
  rateLimiter: RateLimiter;
  defaultHeaders?: Record<string, string>;
  observability?: RegistrarDeps["observability"];
  /** `ctx.waitUntil` seam for the fire-and-forget Assignment Store write. */
  waitUntil?: (promise: Promise<unknown>) => void;
}

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  app.use("*", async (context, next) => {
    if (context.req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: evaluationCorsHeaders() });
    }
    await next();
    for (const [name, value] of evaluationCorsHeaders()) {
      context.res.headers.set(name, value);
    }
    return context.res;
  });
  const registrar = createRegistrar({
    authResolvers: {
      "control-plane-token": deps.authResolver,
      "client-key": makeClientKeyOnlyAuthResolver(deps.dataPlaneAuthResolver),
      "api-key": makeApiKeyOnlyAuthResolver(deps.dataPlaneAuthResolver),
      "data-plane-key": deps.dataPlaneAuthResolver,
    },
    rateLimiter: deps.rateLimiter,
    defaultHeaders: deps.defaultHeaders,
    observability: deps.observability,
  });

  registrar.mount(app, evaluationRoute("sdk_evaluate"), makeEvaluateHandler(deps));
  registrar.mount(
    app,
    evaluationRoute("sdk_cached_evaluation_telemetry"),
    makeCachedEvaluationTelemetryHandler(deps),
  );
  registrar.mount(app, evaluationRoute("sdk_peek"), makePeekHandler(deps));
  registrar.mount(app, evaluationRoute("sdk_verify"), makeVerifyHandler(deps));
  registrar.mount(app, evaluationRoute("flags_test_eval"), makeTestEvaluationHandler(deps));
  return app;
}

function evaluationCorsHeaders(): Headers {
  return new Headers({
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers":
      "authorization, content-type, idempotency-key, x-splitch-sdk-runtime",
    "access-control-expose-headers": "x-request-id, x-run-id",
  });
}
