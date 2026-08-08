import { type Segment, SegmentSchema } from "@splitch/contracts";
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
      return parseControlPlaneResponse(response, "panel_segments_list", {
        safeParse: parseSegmentList,
      });
    },
  };
}

function parseSegmentList(
  input: unknown,
): { success: true; data: PanelSegmentsListOutput } | { success: false } {
  if (!isObject(input) || !Array.isArray(input.items) || !isObject(input.affectedEnvironmentIds)) {
    return { success: false };
  }
  const items: Segment[] = [];
  for (const item of input.items) {
    const parsed = SegmentSchema.safeParse(item);
    if (!parsed.success) return { success: false };
    items.push(parsed.data);
  }
  const affectedEnvironmentIds: Record<string, string[]> = {};
  for (const [segmentId, environmentIds] of Object.entries(input.affectedEnvironmentIds)) {
    if (!Array.isArray(environmentIds) || !environmentIds.every((id) => typeof id === "string")) {
      return { success: false };
    }
    affectedEnvironmentIds[segmentId] = environmentIds;
  }
  return { success: true, data: { items, affectedEnvironmentIds } };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
