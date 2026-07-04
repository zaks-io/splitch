import type { RateLimiter, AuthResolver } from "@splitch/worker-runtime";
import { createRegistrar } from "@splitch/worker-runtime";
import { Hono } from "hono";
import type { EvaluatePathDeps } from "./evaluate/evaluate-path.js";
import type { ExposureAssemblyDeps } from "./evaluate/exposure-assembly.js";
import { makeTestEvaluationHandler } from "./test-evaluation.js";
import { evaluationRoute } from "./routes.js";
import { makeVerifyHandler } from "./verify.js";
import { makeApiKeyOnlyAuthResolver, makeClientKeyOnlyAuthResolver } from "./data-plane-auth.js";
import { makePeekHandler } from "./peek.js";
import { makeEvaluateHandler } from "./evaluate.js";
import type { ExposureSink } from "./exposure-sink.js";

export interface AppDeps extends EvaluatePathDeps {
  authResolver: AuthResolver;
  dataPlaneAuthResolver: AuthResolver;
  exposureAssembly: ExposureAssemblyDeps;
  exposureSink: ExposureSink;
  rateLimiter: RateLimiter;
  defaultHeaders?: Record<string, string>;
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
  });

  registrar.mount(app, evaluationRoute("sdk_evaluate"), makeEvaluateHandler(deps));
  registrar.mount(app, evaluationRoute("sdk_peek"), makePeekHandler(deps));
  registrar.mount(app, evaluationRoute("sdk_verify"), makeVerifyHandler(deps));
  registrar.mount(app, evaluationRoute("flags_test_eval"), makeTestEvaluationHandler(deps));
  return app;
}
