import { createHealthResponse, parsePlatformTarget } from "@splitch/contracts";
import {
  createWorkerObservability,
  workerObservabilityWithWaitUntil,
  wrapWorkerHandler,
} from "@splitch/observability/worker";
import type { RateLimiter } from "@splitch/worker-runtime";
import { AssignmentStoreDurableObject } from "./assignment/assignment-store-do";
import { KvAssignmentStore } from "./assignment/kv-assignment-store";
import { createApp } from "./app";
import {
  makeControlPlaneAuthResolver,
  makeHttpJwksFetcher,
  makeJwksVerifier,
  makeSessionStore,
} from "./control-plane-auth";
import { makeDataPlaneAuthResolver } from "./data-plane-auth";
import type { EvaluationApiEnv } from "./env";
import { makeHttpExposureSink } from "./exposure-sink";
import { makeEnvSaltStore } from "./local-salt-store";
import { KvProvider } from "./provider/kv-provider";

const service = "splitch-evaluation-api";

const allowLimiter: RateLimiter = () => ({ limited: false });

const handler = {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health" || url.pathname === "/") {
      return Response.json(
        createHealthResponse(service, parsePlatformTarget(env.SPLITCH_PLATFORM_TARGET)),
      );
    }

    const controlPlaneAudience = env.CONTROL_PLANE_ORIGIN ?? url.origin;
    const jwksUri = env.AUTH_JWKS_URI ?? `${controlPlaneAudience}/.well-known/jwks.json`;
    const saltStore = makeEnvSaltStore(env);
    const app = createApp({
      authResolver: makeControlPlaneAuthResolver({
        verifier: makeJwksVerifier({
          fetchJwks: makeHttpJwksFetcher(jwksUri),
          controlPlaneAudience,
        }),
        sessions: makeSessionStore(env.SESSION_STORE),
      }),
      dataPlaneAuthResolver: makeDataPlaneAuthResolver(env.CREDENTIAL_STORE),
      rateLimiter: allowLimiter,
      provider: new KvProvider(env.CONFIG_STORE),
      assignmentStore: new KvAssignmentStore(
        env.ASSIGNMENTS_KV,
        env.ASSIGNMENT_STORE_WRITER,
        saltStore,
      ),
      exposureAssembly: {
        saltStore,
        sourceId: env.SPLITCH_SOURCE_ID ?? "local",
      },
      exposureSink: makeHttpExposureSink({
        endpoint: env.EVENT_INGEST_URL,
        fetcher: env.EVENT_INGEST,
        token: env.SPLITCH_EVENT_INGEST_TOKEN,
      }),
      waitUntil: (promise) => ctx.waitUntil(promise),
      logger: console,
      observability: createWorkerObservability(
        env,
        workerObservabilityWithWaitUntil("evaluation-api", ctx),
      ),
    });
    return app.fetch(request, env);
  },
} satisfies ExportedHandler<EvaluationApiEnv>;

export default wrapWorkerHandler(handler, { surface: "evaluation-api" });

export { AssignmentStoreDurableObject };
