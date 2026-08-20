import type { AuthResolver, RateLimiter, RegistrarDeps } from "@splitch/worker-runtime";
import { createRegistrar } from "@splitch/worker-runtime";
import { Hono } from "hono";
import type { HoldoverWriteCoordinator } from "./assignment/holdover-write-outbox";
import { DirectHoldoverWriteCoordinator } from "./assignment/holdover-write-outbox";
import {
  makeHoldoverWriteOutboxCleanupHandler,
  type HoldoverWriteOutboxCleanupDeps,
} from "./assignment/holdover-write-outbox-cleanup";
import { makeCachedEvaluationTelemetryHandler } from "./cached-evaluation-telemetry";
import { makeApiKeyOnlyAuthResolver, makeClientKeyOnlyAuthResolver } from "./data-plane-auth";
import { type DelegationBindings, mountDelegatedRoutes } from "./delegated-routes";
import { makeEvaluateHandler } from "./evaluate";
import type { EvaluatePathDeps } from "./evaluate/evaluate-path";
import type { ExposureAssemblyDeps } from "./evaluate/exposure-assembly";
import type { MintExposureTicketDeps } from "./evaluate/exposure-ticket";
import { makeEvaluateAllHandler } from "./evaluate-all";
import type { EvaluationCommitSink } from "./evaluation-commit-sink";
import type { EvaluationUsageSink } from "./evaluation-usage-sink";
import type { ExposureIngestSink } from "./exposure-redemption";
import type { ExposureRedemptionClaimStore } from "./exposure-redemption-claim-core";
import { makeExposuresHandler } from "./exposures";
import { makePeekHandler } from "./peek";
import { evaluationRoute } from "./routes";
import { makeTestEvaluationHandler } from "./test-evaluation";
import { makeVerifyHandler } from "./verify";

/**
 * Which door of this Worker the app instance is serving.
 *
 * `edge.splitch.dev` must not mount a route whose public address is
 * `api.splitch.dev`. That route holds a control-plane token and arrives here over
 * the Control Plane's binding after it has been authorized; answering it on the
 * public hostname too would be a second live address for the same operation, one
 * the clients are told about and one they are not (ADR-0046).
 *
 * `binding` is the trusted side: the Worker on the other end already picked the
 * operation and authorized the caller, so it mounts everything this Worker
 * executes.
 */
export type EvaluationDoor = "public" | "binding";

export interface AppDeps extends EvaluatePathDeps {
  door: EvaluationDoor;
  authResolver: AuthResolver;
  dataPlaneAuthResolver: AuthResolver;
  exposureAssembly: ExposureAssemblyDeps;
  exposureTicket: MintExposureTicketDeps & { previousTicketKey?: string };
  exposureIngestSink: ExposureIngestSink;
  exposureRedemptionClaims: ExposureRedemptionClaimStore;
  /** Completes or durably owns Assignment Store holdover writes after redemption. */
  holdoverWrite?: HoldoverWriteCoordinator;
  /** Binding-door App/Entity deletion consumer for the holdover-write outbox. */
  holdoverWriteOutboxCleanup?: HoldoverWriteOutboxCleanupDeps;
  evaluationCommitSink: EvaluationCommitSink;
  evaluationUsageSink: EvaluationUsageSink;
  rateLimiter: RateLimiter;
  delegationBindings?: DelegationBindings;
  defaultHeaders?: Record<string, string>;
  observability?: RegistrarDeps["observability"];
  /** `ctx.waitUntil` seam for the fire-and-forget Assignment Store write on evaluate. */
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
      "internal-worker": deps.authResolver,
    },
    rateLimiter: deps.rateLimiter,
    defaultHeaders: deps.defaultHeaders,
    observability: deps.observability,
  });

  mountDelegatedRoutes(app, registrar, deps.delegationBindings ?? {});

  registrar.mount(app, evaluationRoute("sdk_evaluate"), makeEvaluateHandler(deps));
  registrar.mount(
    app,
    evaluationRoute("sdk_cached_evaluation_telemetry"),
    makeCachedEvaluationTelemetryHandler(deps),
  );
  registrar.mount(app, evaluationRoute("sdk_peek"), makePeekHandler(deps));
  registrar.mount(app, evaluationRoute("sdk_verify"), makeVerifyHandler(deps));
  registrar.mount(app, evaluationRoute("sdk_evaluate_all"), makeEvaluateAllHandler(deps));
  registrar.mount(
    app,
    evaluationRoute("sdk_exposures"),
    makeExposuresHandler({
      holdoverWrite:
        deps.holdoverWrite ?? new DirectHoldoverWriteCoordinator(deps.assignmentStore, deps.logger),
      exposureIngestSink: deps.exposureIngestSink,
      exposureRedemptionClaims: deps.exposureRedemptionClaims,
      exposureTicket: deps.exposureTicket,
      sourceId: deps.exposureAssembly.sourceId,
      logger: deps.logger,
    }),
  );
  if (deps.door === "binding") {
    registrar.mount(app, evaluationRoute("flags_test_eval"), makeTestEvaluationHandler(deps));
    if (deps.holdoverWriteOutboxCleanup) {
      registrar.mount(
        app,
        evaluationRoute("holdover_write_outbox_delete"),
        makeHoldoverWriteOutboxCleanupHandler(deps.holdoverWriteOutboxCleanup),
      );
    }
  }
  return app;
}

function evaluationCorsHeaders(): Headers {
  return new Headers({
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers":
      "authorization, content-type, idempotency-key, if-none-match, x-splitch-sdk-runtime",
    "access-control-expose-headers": "etag, x-request-id, x-run-id, x-variant-name",
  });
}
