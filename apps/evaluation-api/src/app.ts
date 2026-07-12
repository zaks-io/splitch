import type { RateLimiter, AuthResolver, RegistrarDeps } from "@splitch/worker-runtime";
import { createRegistrar } from "@splitch/worker-runtime";
import { Hono } from "hono";
import type { EvaluatePathDeps } from "./evaluate/evaluate-path";
import type { ExposureAssemblyDeps } from "./evaluate/exposure-assembly";
import { makeTestEvaluationHandler } from "./test-evaluation";
import { evaluationRoute } from "./routes";
import { makeVerifyHandler } from "./verify";
import { makeApiKeyOnlyAuthResolver, makeClientKeyOnlyAuthResolver } from "./data-plane-auth";
import { makePeekHandler } from "./peek";
import { makeEvaluateHandler } from "./evaluate";
import type { ExposureSink } from "./exposure-sink";

export interface AppDeps extends EvaluatePathDeps {
  authResolver: AuthResolver;
  dataPlaneAuthResolver: AuthResolver;
  exposureAssembly: ExposureAssemblyDeps;
  exposureSink: ExposureSink;
  rateLimiter: RateLimiter;
  defaultHeaders?: Record<string, string>;
  observability?: RegistrarDeps["observability"];
  /** `ctx.waitUntil` seam for the fire-and-forget Assignment Store write. */
  waitUntil?: (promise: Promise<unknown>) => void;
}

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
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
  registrar.mount(app, evaluationRoute("sdk_peek"), makePeekHandler(deps));
  registrar.mount(app, evaluationRoute("sdk_verify"), makeVerifyHandler(deps));
  registrar.mount(app, evaluationRoute("flags_test_eval"), makeTestEvaluationHandler(deps));
  return app;
}
