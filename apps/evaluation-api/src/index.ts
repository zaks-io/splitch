import { createHealthResponse, parsePlatformTarget } from "@splitch/contracts";
import type { RateLimiter } from "@splitch/worker-runtime";
import { createWorkerObservability, wrapWorkerHandler } from "@splitch/observability/worker";
import { AssignmentStoreDurableObject } from "./assignment/assignment-store-do.js";
import { KvAssignmentStore } from "./assignment/kv-assignment-store.js";
import { createApp } from "./app.js";
import {
  makeControlPlaneAuthResolver,
  makeHttpJwksFetcher,
  makeJwksVerifier,
  makeSessionStore,
} from "./control-plane-auth.js";
import { makeDataPlaneAuthResolver } from "./data-plane-auth.js";
import type { EvaluationApiEnv } from "./env.js";
import { makeHttpExposureSink } from "./exposure-sink.js";
import { makeEnvSaltStore } from "./local-salt-store.js";
import { KvProvider } from "./provider/kv-provider.js";

const service = "splitch-evaluation-api";

const allowLimiter: RateLimiter = () => ({ limited: false });

const handler = {
  async fetch(request, env): Promise<Response> {
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
      logger: console,
      observability: createWorkerObservability(env, { surface: "evaluation-api" }),
    });
    return app.fetch(request, env);
  },
} satisfies ExportedHandler<EvaluationApiEnv>;

export default wrapWorkerHandler(handler, { surface: "evaluation-api" });

export { AssignmentStoreDurableObject };
