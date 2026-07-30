import { OpenAPIHono, type RouteConfig } from "@hono/zod-openapi";
import { accountRoutes } from "./routes/routes-account";
import { analysisRoutes } from "./routes/routes-analysis";
import { attentionRoutes } from "./routes/routes-attention";
import { credentialRoutes } from "./routes/routes-credentials";
import { dataPlaneRoutes } from "./routes/routes-data-plane";
import { experimentRoutes } from "./routes/routes-experiments";
import { flagRoutes } from "./routes/routes-flags";
import { privacyRoutes } from "./routes/routes-privacy";

/**
 * Type-only OpenAPIHono app derived from THE route registry (ADR-0025). The
 * Control Plane API Worker mounts the same routes at runtime via
 * @splitch/worker-runtime; this emit-only app exists so downstream packages can
 * `hc<ControlPlaneRpcApp>()` without importing `apps/*`.
 *
 * Ownership: contract-owned. `ControlPlaneRpcApp` is the canonical Hono RPC
 * App type for Control Plane routes (App, Environment, Flag, Variant, Experiment).
 */

function rpcStubHandler(): never {
  throw new Error("openapi-rpc-app: type-only stub must never handle a request");
}

type RpcInputsFromRoutes<T extends readonly { openapi: RouteConfig }[]> = {
  readonly [K in keyof T]: T[K] extends { openapi: infer O extends RouteConfig }
    ? { route: O; handler: typeof rpcStubHandler }
    : never;
};

function buildRpcAppFromRoutes<const T extends readonly { openapi: RouteConfig }[]>(routes: T) {
  const rpcInputs = routes.map((route) => ({
    route: route.openapi,
    handler: rpcStubHandler,
  })) as RpcInputsFromRoutes<T>;
  return new OpenAPIHono().openapiRoutes(rpcInputs);
}

const accountRpcApp = buildRpcAppFromRoutes(accountRoutes);
const attentionRpcApp = buildRpcAppFromRoutes(attentionRoutes);
const flagRpcApp = buildRpcAppFromRoutes(flagRoutes);
const experimentRpcApp = buildRpcAppFromRoutes(experimentRoutes);
const credentialRpcApp = buildRpcAppFromRoutes(credentialRoutes);
const analysisRpcApp = buildRpcAppFromRoutes(analysisRoutes);
const privacyRpcApp = buildRpcAppFromRoutes(privacyRoutes);
const dataPlaneRpcApp = buildRpcAppFromRoutes(dataPlaneRoutes);

/** Emit-only OpenAPIHono carrying the full Control Plane route schema for `hc`. */
export const controlPlaneRpcApp = new OpenAPIHono()
  .route("/", accountRpcApp)
  .route("/", attentionRpcApp)
  .route("/", flagRpcApp)
  .route("/", experimentRpcApp)
  .route("/", credentialRpcApp)
  .route("/", analysisRpcApp)
  .route("/", privacyRpcApp)
  .route("/", dataPlaneRpcApp);

/** Hono RPC App type for Control Plane routes — use with `hc<ControlPlaneRpcApp>()`. */
export type ControlPlaneRpcApp = typeof controlPlaneRpcApp;
