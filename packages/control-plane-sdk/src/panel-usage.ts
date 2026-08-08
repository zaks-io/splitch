import type { OrganizationUsageResponse } from "@splitch/contracts";
import { OrganizationUsageResponseSchema } from "@splitch/contracts";
import type { ControlPlaneOperationResult } from "./operation-result";
import { parseControlPlaneResponse } from "./operation-result";

export interface PanelUsageInput {
  orgId: string;
}

export interface PanelUsageClient {
  get(input: PanelUsageInput): Promise<ControlPlaneOperationResult<OrganizationUsageResponse>>;
}

/**
 * The Panel's Organization Evaluation-usage read (ADR-0033), over the same
 * signed binding every other Panel call uses. The Control Plane addresses the
 * route and the Analysis Worker executes it (ADR-0046); nothing here reaches
 * Tinybird directly.
 */
export function createPanelUsageClient(options: {
  fetch: typeof fetch;
  baseUrl?: string;
}): PanelUsageClient {
  const baseUrl = options.baseUrl ?? "https://control-plane.internal";
  return {
    async get(input) {
      const response = await options.fetch(
        new URL(`/orgs/${encodeURIComponent(input.orgId)}/usage`, baseUrl),
      );
      return parseControlPlaneResponse(
        response,
        "organization_usage_get",
        OrganizationUsageResponseSchema,
      );
    },
  };
}
