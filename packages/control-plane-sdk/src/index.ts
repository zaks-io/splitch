import type { HealthResponse } from "@splitch/contracts";
import { HealthResponseSchema } from "@splitch/contracts";
import { type AppsClient, createAppsClient } from "./apps-client";
import { type CredentialsClient, createCredentialsClient } from "./credentials-client";
import { createEnvironmentsClient, type EnvironmentsClient } from "./environments-client";
import { createExperimentsClient, type ExperimentsClient } from "./experiments-client";
import { createFlagsClient, type FlagsClient } from "./flags-client";
import {
  type ControlPlaneHcOptions,
  createAppsHcClient,
  createCredentialsHcClient,
  createEnvironmentsHcClient,
  createExperimentsHcClient,
  createFlagsHcClient,
  createOrganizationsHcClient,
  resolveControlPlaneUrl,
} from "./hc-client";
import { createOrganizationsClient, type OrganizationsClient } from "./organizations-client";

export interface ControlPlaneSdkOptions {
  readonly baseUrl: string;
  readonly fetch?: typeof fetch;
}

/**
 * Typed Control Plane SDK for normal consumers (CLI, control panel, agents).
 *
 * Use the route groups (`flags`, `experiments`, …) backed by Hono `hc<ControlPlaneClientApp>()`.
 * For MCP dynamic tool execution by `operationId`, import `@splitch/control-plane-sdk/mcp-operation-adapter`.
 */
export interface ControlPlaneSdk {
  health(): Promise<HealthResponse>;
  readonly organizations: OrganizationsClient;
  readonly apps: AppsClient;
  readonly environments: EnvironmentsClient;
  readonly credentials: CredentialsClient;
  readonly flags: FlagsClient;
  readonly experiments: ExperimentsClient;
}

export function createControlPlaneSdk(options: ControlPlaneSdkOptions): ControlPlaneSdk {
  const requestFetch = options.fetch ?? fetch;
  const baseUrl = new URL(options.baseUrl);
  const hcOptions: ControlPlaneHcOptions = {
    baseUrl: baseUrl.toString(),
    fetch: requestFetch,
  };
  const flagsHcClient = createFlagsHcClient(hcOptions);
  const experimentsHcClient = createExperimentsHcClient(hcOptions);
  const appsHcClient = createAppsHcClient(hcOptions);
  const environmentsHcClient = createEnvironmentsHcClient(hcOptions);
  const credentialsHcClient = createCredentialsHcClient(hcOptions);
  const organizationsHcClient = createOrganizationsHcClient(hcOptions);

  return {
    async health() {
      const response = await requestFetch(resolveControlPlaneUrl(baseUrl, "/health"));

      if (!response.ok) {
        throw new Error(`splitch health check failed: ${response.status}`);
      }

      return HealthResponseSchema.parse(await response.json());
    },
    organizations: createOrganizationsClient(hcOptions, organizationsHcClient),
    apps: createAppsClient(hcOptions, appsHcClient),
    environments: createEnvironmentsClient(hcOptions, environmentsHcClient),
    credentials: createCredentialsClient(hcOptions, credentialsHcClient),
    flags: createFlagsClient(hcOptions, flagsHcClient),
    experiments: createExperimentsClient(hcOptions, experimentsHcClient),
  };
}

export type {
  AppsCreateInput,
  AppsCreateOutput,
  AppAttentionRollupGetInput,
  AppAttentionRollupGetOutput,
  FlagConfigGetInput,
  FlagConfigGetOutput,
  FlagConfigUpdateInput,
  FlagConfigUpdateOutput,
  OrganizationsCreateInput,
  OrganizationsCreateOutput,
  RouteFlatInput,
  RouteInput,
  RouteOutput,
} from "@splitch/contracts/route-types";
export type { AppsClient } from "./apps-client";
export type { CredentialsClient } from "./credentials-client";
export type { EnvironmentsClient } from "./environments-client";
export type { ExperimentsClient } from "./experiments-client";
export type { FlagsClient } from "./flags-client";
export type { OrganizationsClient } from "./organizations-client";
export type {
  ControlPlaneOperationOptions,
  ControlPlaneOperationResult,
} from "./operation-result";
