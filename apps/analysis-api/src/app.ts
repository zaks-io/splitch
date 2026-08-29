import { createHealthResponse, parsePlatformTarget } from "@splitch/contracts";
import {
  type AuthResolver,
  createRegistrar,
  type RateLimiter,
  type Registrar,
  type RegistrarDeps,
} from "@splitch/worker-runtime";
import { Hono } from "hono";
import {
  makeExposureStatusCleanupHandler,
  type ExposureStatusCleanupDeps,
} from "./exposure-status-cleanup";
import { makeEntityPrivacyHandler, type EntityPrivacyDeps } from "./entity-privacy";
import { makeExposureStatusHandler, type ExposureStatusDeps } from "./exposure-status";
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

export interface AnalysisAppDeps
  extends ResultsDeps,
    UsageDeps,
    ExposureStatusDeps,
    ExposureStatusCleanupDeps,
    EntityPrivacyDeps {
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
  const exposureStatusHandler = makeExposureStatusHandler(deps);
  const exposureStatusCleanupHandler = makeExposureStatusCleanupHandler(deps);
  const entityPrivacyExportHandler = makeEntityPrivacyHandler(deps, "export");
  const entityPrivacySuppressHandler = makeEntityPrivacyHandler(deps, "suppress");
  const entityPrivacyDeleteHandler = makeEntityPrivacyHandler(deps, "delete");
  registrar.mount(app, analysisRoute("experiment_results_get"), resultsHandler);
  registrar.mount(app, analysisRoute("experiment_results_post"), resultsHandler);
  registrar.mount(app, analysisRoute("organization_usage_get"), usageHandler);
  registrar.mount(app, analysisRoute("environment_exposure_status_get"), exposureStatusHandler);
  registrar.mount(
    app,
    analysisRoute("environment_exposure_status_delete"),
    exposureStatusCleanupHandler,
  );
  registrar.mount(app, analysisRoute("entity_analysis_privacy_export"), entityPrivacyExportHandler);
  registrar.mount(
    app,
    analysisRoute("entity_analysis_privacy_suppress"),
    entityPrivacySuppressHandler,
  );
  registrar.mount(app, analysisRoute("entity_analysis_privacy_delete"), entityPrivacyDeleteHandler);

  return app;
}

function analysisRegistrar(deps: AnalysisAppDeps): Registrar {
  return createRegistrar({
    authResolvers: {
      "control-plane-token": deps.authResolver,
      "internal-worker": deps.authResolver,
    },
    rateLimiter: deps.rateLimiter,
    defaultHeaders: deps.defaultHeaders,
    observability: deps.observability,
  });
}
