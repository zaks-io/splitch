import type { AuthResolver, Principal, RateLimiter } from "@splitch/worker-runtime";
import { createApp } from "./app";
import {
  APP_ID,
  ENVIRONMENT_ID,
  EXPERIMENT_ID,
  FakeTinybird,
  OTHER_APP_ID,
  type RowsByPipe,
} from "./results-test-support";
import type { TinybirdReadTransport } from "./tinybird";

export const RESULTS_PATH = `/apps/${APP_ID}/envs/${ENVIRONMENT_ID}/experiments/${EXPERIMENT_ID}/results`;
export const RESULTS_REQUEST = new Request(`https://analysis.test${RESULTS_PATH}`);

const allowLimiter: RateLimiter = () => ({ limited: false });

export function principal(appId: string | null, environmentId: string | null = null): Principal {
  return {
    kind: "control-plane-token",
    id: "actor-1",
    scopes: appId === null ? [] : [`app:${appId}:admin`],
    orgId: null,
    appId,
    environmentId,
    authDoor: "id_jag",
  };
}

const resultsAuthResolver: AuthResolver = (request) => {
  const authorization = request.headers.get("authorization");
  if (authorization === "Bearer cp-app") {
    return { ok: true, principal: principal(APP_ID) };
  }
  if (authorization === "Bearer cp-other-app") {
    return { ok: true, principal: principal(OTHER_APP_ID) };
  }
  if (authorization === "Bearer cp-no-app") {
    return { ok: true, principal: principal(null) };
  }
  if (authorization === "Bearer cp-other-env") {
    return { ok: true, principal: principal(APP_ID, "env_other") };
  }
  return { ok: false, reason: "UNAUTHORIZED" };
};

export function makeResultsHarness(rows?: RowsByPipe) {
  const tinybird = new FakeTinybird(rows);
  const app = createApp({
    door: "binding",
    authResolver: resultsAuthResolver,
    rateLimiter: allowLimiter,
    tinybird,
    platformTarget: "local",
  });
  return { app, tinybird };
}

export function makeResultsApp(tinybird: TinybirdReadTransport) {
  return createApp({
    door: "binding",
    authResolver: resultsAuthResolver,
    rateLimiter: allowLimiter,
    tinybird,
    platformTarget: "local",
  });
}

export function resultsAuthInit(method: "GET" | "POST", body?: unknown): RequestInit {
  return {
    method,
    headers: {
      authorization: "Bearer cp-app",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}
