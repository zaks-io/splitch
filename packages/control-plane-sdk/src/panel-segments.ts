import { type Segment, SegmentListResponseSchema } from "@splitch/contracts";
import type { ControlPlaneOperationResult } from "./operation-result";
import { parseControlPlaneResponse } from "./operation-result";

export interface PanelSegmentsListOutput {
  items: Segment[];
  affectedEnvironmentIds: Record<string, string[]>;
}

export interface PanelSegmentsClient {
  list(input: { appId: string }): Promise<ControlPlaneOperationResult<PanelSegmentsListOutput>>;
}

export function createPanelSegmentsClient(options: {
  fetch: typeof fetch;
  baseUrl?: string;
}): PanelSegmentsClient {
  const baseUrl = options.baseUrl ?? "https://control-plane.internal";
  return {
    async list(input) {
      const response = await options.fetch(
        new URL(`/apps/${encodeURIComponent(input.appId)}/segments`, baseUrl),
      );
      return parseControlPlaneResponse(response, "panel_segments_list", SegmentListResponseSchema);
    },
  };
}
