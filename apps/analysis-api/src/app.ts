import { createHealthResponse, parsePlatformTarget } from "@splitch/contracts";
import {
  type AuthResolver,
  createRegistrar,
  type RateLimiter,
  type Registrar,
  type RegistrarDeps,
} from "@splitch/worker-runtime";
import { Hono } from "hono";
import { makeResultsHandler, type ResultsDeps } from "./results";
import { analysisRoute } from "./routes";
import { makeUsageHandler, type UsageDeps } from "./usage";

const service = "splitch-analysis-api";

export interface AnalysisAppDeps extends ResultsDeps, UsageDeps {
  authResolver: AuthResolver;
  rateLimiter: RateLimiter;
  platformTarget?: string;
  defaultHeaders?: Record<string, string>;
  observability?: RegistrarDeps["observability"];
}

export function createApp(deps: AnalysisAppDeps): Hono {
  const app = new Hono();
  const health = () =>
    Response.json(createHealthResponse(service, parsePlatformTarget(deps.platformTarget)));
  const registrar = analysisRegistrar(deps);
  const resultsHandler = makeResultsHandler(deps);
  const usageHandler = makeUsageHandler(deps);

  app.get("/", health);
  app.get("/health", health);
  registrar.mount(app, analysisRoute("experiment_results_get"), resultsHandler);
  registrar.mount(app, analysisRoute("experiment_results_post"), resultsHandler);
  registrar.mount(app, analysisRoute("organization_usage_get"), usageHandler);

  return app;
}

function analysisRegistrar(deps: AnalysisAppDeps): Registrar {
  return createRegistrar({
    authResolvers: { "control-plane-token": deps.authResolver },
    rateLimiter: deps.rateLimiter,
    defaultHeaders: deps.defaultHeaders,
    observability: deps.observability,
  });
}
