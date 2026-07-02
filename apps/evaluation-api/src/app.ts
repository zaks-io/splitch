import type { RateLimiter, AuthResolver } from "@splitch/worker-runtime";
import { createRegistrar } from "@splitch/worker-runtime";
import { Hono } from "hono";
import type { EvaluatePathDeps } from "./evaluate/evaluate-path.js";
import { makeTestEvaluationHandler } from "./test-evaluation.js";
import { evaluationRoute } from "./routes.js";

export interface AppDeps extends EvaluatePathDeps {
  authResolver: AuthResolver;
  rateLimiter: RateLimiter;
  defaultHeaders?: Record<string, string>;
}

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  const registrar = createRegistrar({
    authResolvers: { "control-plane-token": deps.authResolver },
    rateLimiter: deps.rateLimiter,
    defaultHeaders: deps.defaultHeaders,
  });

  registrar.mount(app, evaluationRoute("flags_test_eval"), makeTestEvaluationHandler(deps));
  return app;
}
