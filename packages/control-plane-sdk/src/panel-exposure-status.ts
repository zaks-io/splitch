import {
  type EnvironmentExposureStatusResponse,
  EnvironmentExposureStatusResponseSchema,
} from "@splitch/contracts";
import type { ControlPlaneOperationResult } from "./operation-result";
import { parseControlPlaneResponse } from "./operation-result";

export interface PanelExposureStatusScope {
  appId: string;
  environmentId: string;
}

export interface PanelExposureStatusClient {
  get(
    input: PanelExposureStatusScope,
  ): Promise<ControlPlaneOperationResult<EnvironmentExposureStatusResponse>>;
}

export function createPanelExposureStatusClient(options: {
  fetch: typeof fetch;
  baseUrl?: string;
}): PanelExposureStatusClient {
  const baseUrl = options.baseUrl ?? "https://control-plane.internal";
  return {
    async get(input) {
      const path =
        `/apps/${encodeURIComponent(input.appId)}` +
        `/envs/${encodeURIComponent(input.environmentId)}/exposure-status`;
      const response = await options.fetch(new URL(path, baseUrl), { method: "GET" });
      return parseControlPlaneResponse(
        response,
        "environment_exposure_status_get",
        EnvironmentExposureStatusResponseSchema,
      );
    },
  };
}
