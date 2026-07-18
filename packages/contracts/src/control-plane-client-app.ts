import { OpenAPIHono } from "@hono/zod-openapi";
import type { ApiRouteContract } from "./openapi-route";
import { accountRoutes } from "./routes/routes-account";
import { experimentRoutes } from "./routes/routes-experiments";
import { flagRoutes } from "./routes/routes-flags";

/**
 * Emit-only OpenAPIHono apps built from THE route registry so `hc<AppType>()`
 * infers per-route input/output from the same Zod schemas the Worker mounts and MCP
 * derives. Apps are never served; they exist only to thread contract types into
 * @splitch/control-plane-sdk without importing deployable Worker code.
 *
 * Split by domain (flags / experiments) so `hc` inference stays within TS limits.
 */

function emitOnlyHandler(
  route: ApiRouteContract,
): (c: { json: (body: unknown, status: number) => Response }) => Response {
  return (c) => {
    const empty = route.output.safeParse(undefined);
    const body = empty.success ? empty.data : {};
    return c.json(body, 200);
  };
}

const flagsSdkRoutes = [
  flagRoutes[0],
  flagRoutes[1],
  flagRoutes[2],
  flagRoutes[3],
  flagRoutes[4],
  flagRoutes[8],
  flagRoutes[9],
] as const;

const experimentsSdkRoutes = [
  experimentRoutes[0],
  experimentRoutes[1],
  experimentRoutes[2],
  experimentRoutes[3],
  experimentRoutes[4],
  experimentRoutes[5],
] as const;

const appsSdkRoutes = [accountRoutes[9]] as const;

const flagsControlPlaneClientApp = new OpenAPIHono().openapiRoutes([
  { route: flagsSdkRoutes[0].openapi, handler: emitOnlyHandler(flagsSdkRoutes[0]) },
  { route: flagsSdkRoutes[1].openapi, handler: emitOnlyHandler(flagsSdkRoutes[1]) },
  { route: flagsSdkRoutes[2].openapi, handler: emitOnlyHandler(flagsSdkRoutes[2]) },
  { route: flagsSdkRoutes[3].openapi, handler: emitOnlyHandler(flagsSdkRoutes[3]) },
  { route: flagsSdkRoutes[4].openapi, handler: emitOnlyHandler(flagsSdkRoutes[4]) },
  { route: flagsSdkRoutes[5].openapi, handler: emitOnlyHandler(flagsSdkRoutes[5]) },
  { route: flagsSdkRoutes[6].openapi, handler: emitOnlyHandler(flagsSdkRoutes[6]) },
] as const);

const experimentsControlPlaneClientApp = new OpenAPIHono().openapiRoutes([
  { route: experimentsSdkRoutes[0].openapi, handler: emitOnlyHandler(experimentsSdkRoutes[0]) },
  { route: experimentsSdkRoutes[1].openapi, handler: emitOnlyHandler(experimentsSdkRoutes[1]) },
  { route: experimentsSdkRoutes[2].openapi, handler: emitOnlyHandler(experimentsSdkRoutes[2]) },
  { route: experimentsSdkRoutes[3].openapi, handler: emitOnlyHandler(experimentsSdkRoutes[3]) },
  { route: experimentsSdkRoutes[4].openapi, handler: emitOnlyHandler(experimentsSdkRoutes[4]) },
  { route: experimentsSdkRoutes[5].openapi, handler: emitOnlyHandler(experimentsSdkRoutes[5]) },
] as const);

const appsControlPlaneClientApp = new OpenAPIHono().openapiRoutes([
  { route: appsSdkRoutes[0].openapi, handler: emitOnlyHandler(appsSdkRoutes[0]) },
] as const);

/** `hc<FlagsControlPlaneClientApp>()` — flag route group client type. */
export type FlagsControlPlaneClientApp = typeof flagsControlPlaneClientApp;

/** `hc<ExperimentsControlPlaneClientApp>()` — experiment route group client type. */
export type ExperimentsControlPlaneClientApp = typeof experimentsControlPlaneClientApp;

/** `hc<AppsControlPlaneClientApp>()` — App route group client type. */
export type AppsControlPlaneClientApp = typeof appsControlPlaneClientApp;

/** Union of SDK emit-only apps; prefer domain-specific types for `hc`. */
export type ControlPlaneClientApp =
  | FlagsControlPlaneClientApp
  | ExperimentsControlPlaneClientApp
  | AppsControlPlaneClientApp;

export function createFlagsControlPlaneClientApp(): FlagsControlPlaneClientApp {
  return flagsControlPlaneClientApp;
}

export function createExperimentsControlPlaneClientApp(): ExperimentsControlPlaneClientApp {
  return experimentsControlPlaneClientApp;
}

export function createAppsControlPlaneClientApp(): AppsControlPlaneClientApp {
  return appsControlPlaneClientApp;
}

/** @deprecated Use {@link createFlagsControlPlaneClientApp} or {@link createExperimentsControlPlaneClientApp}. */
export function createControlPlaneClientApp(): FlagsControlPlaneClientApp {
  return flagsControlPlaneClientApp;
}
