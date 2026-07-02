import { createHealthResponse, parsePlatformTarget } from "@splitch/contracts";
import type { RateLimiter } from "@splitch/worker-runtime";
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
import { makeEnvSaltStore } from "./local-salt-store.js";
import { KvProvider } from "./provider/kv-provider.js";

const service = "splitch-evaluation-api";

const allowLimiter: RateLimiter = () => ({ limited: false });

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health" || url.pathname === "/") {
      return Response.json(
        createHealthResponse(service, parsePlatformTarget(env.SPLITCH_PLATFORM_TARGET)),
      );
    }

    const controlPlaneAudience = env.CONTROL_PLANE_ORIGIN ?? url.origin;
    const jwksUri = env.AUTH_JWKS_URI ?? `${controlPlaneAudience}/.well-known/jwks.json`;
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
        makeEnvSaltStore(env),
      ),
      logger: console,
    });
    return app.fetch(request, env);
  },
} satisfies ExportedHandler<EvaluationApiEnv>;

export { AssignmentStoreDurableObject };
