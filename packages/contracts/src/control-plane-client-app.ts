import { OpenAPIHono } from "@hono/zod-openapi";
import type { ApiRouteContract } from "./openapi-route";
import { accountRoutes } from "./routes/routes-account";
import { approvalRoutes } from "./routes/routes-approvals";
import { attentionRoutes } from "./routes/routes-attention";
import { credentialRoutes } from "./routes/routes-credentials";
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

/**
 * Route subsets are selected by INDEX because `hc` needs the statically-typed
 * tuple element to infer per-route input/output — `getRoute(operationId)` widens
 * to `ApiRouteContract` and collapses inference. Indices are fragile under a
 * route reorder, so `control-plane-client-app.test.ts` asserts the selected
 * operationIds BY NAME: a reorder fails that test loudly instead of silently
 * changing which operations the SDK exposes.
 */
const flagsSdkRoutes = [
  flagRoutes[0],
  flagRoutes[1],
  flagRoutes[2],
  flagRoutes[3],
  flagRoutes[4],
  flagRoutes[5],
  flagRoutes[6],
  flagRoutes[7],
  flagRoutes[8],
  flagRoutes[9],
  flagRoutes[10],
  flagRoutes[11],
] as const;

const experimentsSdkRoutes = [
  experimentRoutes[0],
  experimentRoutes[1],
  experimentRoutes[2],
  experimentRoutes[3],
  experimentRoutes[4],
  experimentRoutes[5],
] as const;

// Only `organizations_create` (SPL-171). The rest of the Organization surface
// reaches the Panel through its own binding path, not this SDK.
const organizationsSdkRoutes = [accountRoutes[1]] as const;

const appsSdkRoutes = [
  accountRoutes[9],
  accountRoutes[10],
  accountRoutes[11],
  accountRoutes[12],
  accountRoutes[13],
  attentionRoutes[0],
  accountRoutes[19],
  accountRoutes[20],
  accountRoutes[21],
  accountRoutes[22],
] as const;

const environmentsSdkRoutes = [
  accountRoutes[14],
  accountRoutes[15],
  accountRoutes[16],
  accountRoutes[17],
  accountRoutes[18],
] as const;

const credentialsSdkRoutes = [
  credentialRoutes[0],
  credentialRoutes[1],
  credentialRoutes[2],
  credentialRoutes[3],
  credentialRoutes[4],
  credentialRoutes[5],
] as const;

const approvalsSdkRoutes = [approvalRoutes[0], approvalRoutes[1], approvalRoutes[2]] as const;

const flagsControlPlaneClientApp = new OpenAPIHono().openapiRoutes([
  { route: flagsSdkRoutes[0].openapi, handler: emitOnlyHandler(flagsSdkRoutes[0]) },
  { route: flagsSdkRoutes[1].openapi, handler: emitOnlyHandler(flagsSdkRoutes[1]) },
  { route: flagsSdkRoutes[2].openapi, handler: emitOnlyHandler(flagsSdkRoutes[2]) },
  { route: flagsSdkRoutes[3].openapi, handler: emitOnlyHandler(flagsSdkRoutes[3]) },
  { route: flagsSdkRoutes[4].openapi, handler: emitOnlyHandler(flagsSdkRoutes[4]) },
  { route: flagsSdkRoutes[5].openapi, handler: emitOnlyHandler(flagsSdkRoutes[5]) },
  { route: flagsSdkRoutes[6].openapi, handler: emitOnlyHandler(flagsSdkRoutes[6]) },
  { route: flagsSdkRoutes[7].openapi, handler: emitOnlyHandler(flagsSdkRoutes[7]) },
  { route: flagsSdkRoutes[8].openapi, handler: emitOnlyHandler(flagsSdkRoutes[8]) },
  { route: flagsSdkRoutes[9].openapi, handler: emitOnlyHandler(flagsSdkRoutes[9]) },
  { route: flagsSdkRoutes[10].openapi, handler: emitOnlyHandler(flagsSdkRoutes[10]) },
  { route: flagsSdkRoutes[11].openapi, handler: emitOnlyHandler(flagsSdkRoutes[11]) },
] as const);

const experimentsControlPlaneClientApp = new OpenAPIHono().openapiRoutes([
  { route: experimentsSdkRoutes[0].openapi, handler: emitOnlyHandler(experimentsSdkRoutes[0]) },
  { route: experimentsSdkRoutes[1].openapi, handler: emitOnlyHandler(experimentsSdkRoutes[1]) },
  { route: experimentsSdkRoutes[2].openapi, handler: emitOnlyHandler(experimentsSdkRoutes[2]) },
  { route: experimentsSdkRoutes[3].openapi, handler: emitOnlyHandler(experimentsSdkRoutes[3]) },
  { route: experimentsSdkRoutes[4].openapi, handler: emitOnlyHandler(experimentsSdkRoutes[4]) },
  { route: experimentsSdkRoutes[5].openapi, handler: emitOnlyHandler(experimentsSdkRoutes[5]) },
] as const);

const organizationsControlPlaneClientApp = new OpenAPIHono().openapiRoutes([
  { route: organizationsSdkRoutes[0].openapi, handler: emitOnlyHandler(organizationsSdkRoutes[0]) },
] as const);

const appsControlPlaneClientApp = new OpenAPIHono().openapiRoutes([
  { route: appsSdkRoutes[0].openapi, handler: emitOnlyHandler(appsSdkRoutes[0]) },
  { route: appsSdkRoutes[1].openapi, handler: emitOnlyHandler(appsSdkRoutes[1]) },
  { route: appsSdkRoutes[2].openapi, handler: emitOnlyHandler(appsSdkRoutes[2]) },
  { route: appsSdkRoutes[3].openapi, handler: emitOnlyHandler(appsSdkRoutes[3]) },
  { route: appsSdkRoutes[4].openapi, handler: emitOnlyHandler(appsSdkRoutes[4]) },
  { route: appsSdkRoutes[5].openapi, handler: emitOnlyHandler(appsSdkRoutes[5]) },
  { route: appsSdkRoutes[6].openapi, handler: emitOnlyHandler(appsSdkRoutes[6]) },
  { route: appsSdkRoutes[7].openapi, handler: emitOnlyHandler(appsSdkRoutes[7]) },
  { route: appsSdkRoutes[8].openapi, handler: emitOnlyHandler(appsSdkRoutes[8]) },
  { route: appsSdkRoutes[9].openapi, handler: emitOnlyHandler(appsSdkRoutes[9]) },
] as const);

const environmentsControlPlaneClientApp = new OpenAPIHono().openapiRoutes([
  { route: environmentsSdkRoutes[0].openapi, handler: emitOnlyHandler(environmentsSdkRoutes[0]) },
  { route: environmentsSdkRoutes[1].openapi, handler: emitOnlyHandler(environmentsSdkRoutes[1]) },
  { route: environmentsSdkRoutes[2].openapi, handler: emitOnlyHandler(environmentsSdkRoutes[2]) },
  { route: environmentsSdkRoutes[3].openapi, handler: emitOnlyHandler(environmentsSdkRoutes[3]) },
  { route: environmentsSdkRoutes[4].openapi, handler: emitOnlyHandler(environmentsSdkRoutes[4]) },
] as const);

const credentialsControlPlaneClientApp = new OpenAPIHono().openapiRoutes([
  { route: credentialsSdkRoutes[0].openapi, handler: emitOnlyHandler(credentialsSdkRoutes[0]) },
  { route: credentialsSdkRoutes[1].openapi, handler: emitOnlyHandler(credentialsSdkRoutes[1]) },
  { route: credentialsSdkRoutes[2].openapi, handler: emitOnlyHandler(credentialsSdkRoutes[2]) },
  { route: credentialsSdkRoutes[3].openapi, handler: emitOnlyHandler(credentialsSdkRoutes[3]) },
  { route: credentialsSdkRoutes[4].openapi, handler: emitOnlyHandler(credentialsSdkRoutes[4]) },
  { route: credentialsSdkRoutes[5].openapi, handler: emitOnlyHandler(credentialsSdkRoutes[5]) },
] as const);

const approvalsControlPlaneClientApp = new OpenAPIHono().openapiRoutes([
  { route: approvalsSdkRoutes[0].openapi, handler: emitOnlyHandler(approvalsSdkRoutes[0]) },
  { route: approvalsSdkRoutes[1].openapi, handler: emitOnlyHandler(approvalsSdkRoutes[1]) },
  { route: approvalsSdkRoutes[2].openapi, handler: emitOnlyHandler(approvalsSdkRoutes[2]) },
] as const);

/** `hc<FlagsControlPlaneClientApp>()` — flag route group client type. */
export type FlagsControlPlaneClientApp = typeof flagsControlPlaneClientApp;

/** `hc<ExperimentsControlPlaneClientApp>()` — experiment route group client type. */
export type ExperimentsControlPlaneClientApp = typeof experimentsControlPlaneClientApp;

/** `hc<OrganizationsControlPlaneClientApp>()` — Organization route group client type. */
export type OrganizationsControlPlaneClientApp = typeof organizationsControlPlaneClientApp;

/** `hc<AppsControlPlaneClientApp>()` — App route group client type. */
export type AppsControlPlaneClientApp = typeof appsControlPlaneClientApp;

/** `hc<EnvironmentsControlPlaneClientApp>()` — Environment route group client type. */
export type EnvironmentsControlPlaneClientApp = typeof environmentsControlPlaneClientApp;

/** `hc<CredentialsControlPlaneClientApp>()` — SDK credential route group client type. */
export type CredentialsControlPlaneClientApp = typeof credentialsControlPlaneClientApp;
export type ApprovalsControlPlaneClientApp = typeof approvalsControlPlaneClientApp;

/** Union of SDK emit-only apps; prefer domain-specific types for `hc`. */
export type ControlPlaneClientApp =
  | FlagsControlPlaneClientApp
  | ExperimentsControlPlaneClientApp
  | OrganizationsControlPlaneClientApp
  | AppsControlPlaneClientApp
  | EnvironmentsControlPlaneClientApp
  | CredentialsControlPlaneClientApp
  | ApprovalsControlPlaneClientApp;

export function createFlagsControlPlaneClientApp(): FlagsControlPlaneClientApp {
  return flagsControlPlaneClientApp;
}

export function createExperimentsControlPlaneClientApp(): ExperimentsControlPlaneClientApp {
  return experimentsControlPlaneClientApp;
}

export function createAppsControlPlaneClientApp(): AppsControlPlaneClientApp {
  return appsControlPlaneClientApp;
}

export function createEnvironmentsControlPlaneClientApp(): EnvironmentsControlPlaneClientApp {
  return environmentsControlPlaneClientApp;
}

export function createCredentialsControlPlaneClientApp(): CredentialsControlPlaneClientApp {
  return credentialsControlPlaneClientApp;
}

export function createApprovalsControlPlaneClientApp(): ApprovalsControlPlaneClientApp {
  return approvalsControlPlaneClientApp;
}

/** @deprecated Use {@link createFlagsControlPlaneClientApp} or {@link createExperimentsControlPlaneClientApp}. */
export function createControlPlaneClientApp(): FlagsControlPlaneClientApp {
  return flagsControlPlaneClientApp;
}
