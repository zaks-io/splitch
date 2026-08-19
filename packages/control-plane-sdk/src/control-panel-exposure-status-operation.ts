import type { ControlPanelOperation } from "./control-panel-operation";

const EXPOSURE_STATUS_PATH = /^\/apps\/([^/]+)\/envs\/([^/]+)\/exposure-status\/?$/;

export function parseEnvironmentExposureStatus(
  method: string,
  pathname: string,
): ControlPanelOperation | null {
  const match = pathname.match(EXPOSURE_STATUS_PATH);
  if (method !== "GET" || !match?.[1] || !match[2]) return null;
  try {
    return {
      id: "environment_exposure_status_get",
      appId: decodeURIComponent(match[1]),
      environmentId: decodeURIComponent(match[2]),
    };
  } catch {
    return null;
  }
}
