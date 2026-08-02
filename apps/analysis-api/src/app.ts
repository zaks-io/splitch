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

/**
 * Which door of this Worker the app instance is serving.
 *
 * Analysis is nobody's public surface: every route it owns is addressed at
 * `api.splitch.dev` and reaches it over a service binding (ADR-0046). So its
 * `public` door mounts no registry route at all, and today that is enforced here
 * rather than by the absence of a DNS record — a hostname pointed at this Worker
 * tomorrow must not silently open a second address for every Analysis operation.
 */
export type AnalysisDoor = "public" | "binding";

export interface AnalysisAppDeps extends ResultsDeps, UsageDeps {
  door: AnalysisDoor;
  authResolver: AuthResolver;
  rateLimiter: RateLimiter;
  deployedCommitSha?: string;
  platformTarget?: string;
  defaultHeaders?: Record<string, string>;
  observability?: RegistrarDeps["observability"];
}

export function createApp(deps: AnalysisAppDeps): Hono {
  const app = new Hono();
  const health = () =>
    Response.json(
      createHealthResponse(
        service,
        parsePlatformTarget(deps.platformTarget),
        deps.deployedCommitSha,
      ),
    );
  app.get("/", health);
  app.get("/health", health);
  if (deps.door === "public") {
    return app;
  }

  const registrar = analysisRegistrar(deps);
  const resultsHandler = makeResultsHandler(deps);
  const usageHandler = makeUsageHandler(deps);
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
