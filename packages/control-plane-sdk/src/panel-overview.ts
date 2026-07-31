import { type AppOverviewResponse, AppOverviewResponseSchema } from "@splitch/contracts";
import type { ControlPlaneOperationResult } from "./operation-result";
import { parseControlPlaneResponse } from "./operation-result";

export interface PanelOverviewScope {
  appId: string;
  environmentId: string;
}

export interface PanelOverviewClient {
  read(input: PanelOverviewScope): Promise<ControlPlaneOperationResult<AppOverviewResponse>>;
}

export function createPanelOverviewClient(options: {
  fetch: typeof fetch;
  baseUrl?: string;
}): PanelOverviewClient {
  const baseUrl = options.baseUrl ?? "https://control-plane.internal";
  return {
    async read(input) {
      const path =
        `/control-panel/apps/${encodeURIComponent(input.appId)}` +
        `/envs/${encodeURIComponent(input.environmentId)}/overview`;
      const response = await options.fetch(new URL(path, baseUrl), { method: "GET" });
      // The far end validates its own output; this validates the near end, so a
      // shape the Panel cannot render becomes a loud parse failure rather than a
      // half-rendered dashboard (ADR-0036).
      return parseControlPlaneResponse<AppOverviewResponse>(response, "panel_overview_get", {
        safeParse: (value) => AppOverviewResponseSchema.safeParse(value),
      });
    },
  };
}
