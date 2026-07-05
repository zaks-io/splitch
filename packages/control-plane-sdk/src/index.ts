import type { HealthResponse } from "@splitch/contracts";
import { HealthResponseSchema } from "@splitch/contracts";
import { createControlPlaneHcClient, type ControlPlaneHcOptions } from "./hc-client";
import { createExperimentsClient, type ExperimentsClient } from "./experiments-client";
import { createFlagsClient, type FlagsClient } from "./flags-client";

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
  const hcClient = createControlPlaneHcClient(hcOptions);

  return {
    async health() {
      const response = await requestFetch(new URL("/health", baseUrl));

      if (!response.ok) {
        throw new Error(`splitch health check failed: ${response.status}`);
      }

      return HealthResponseSchema.parse(await response.json());
    },
    flags: createFlagsClient(hcOptions, hcClient),
    experiments: createExperimentsClient(hcOptions, hcClient),
  };
}

export type {
  ControlPlaneOperationOptions,
  ControlPlaneOperationResult,
} from "./operation-result";
export type { ExperimentsClient } from "./experiments-client";
export type { FlagsClient } from "./flags-client";
export type { RouteFlatInput, RouteInput, RouteOutput } from "@splitch/contracts/route-types";
