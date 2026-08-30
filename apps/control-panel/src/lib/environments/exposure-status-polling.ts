import type { EnvironmentExposureStatusResponse } from "@splitch/contracts";

export const EXPOSURE_STATUS_POLL_INTERVAL_MS = 5_000;

export function exposureStatusRefetchInterval(input: {
  isError: boolean;
  data: EnvironmentExposureStatusResponse | undefined;
}): number | false {
  return !input.isError && input.data?.state === "not_received"
    ? EXPOSURE_STATUS_POLL_INTERVAL_MS
    : false;
}

export function exposureStatusDisplayState(input: {
  isPending: boolean;
  isError: boolean;
  data: EnvironmentExposureStatusResponse | undefined;
}): "loading" | "error" | EnvironmentExposureStatusResponse["state"] | null {
  if (input.isPending) return "loading";
  if (input.isError) return "error";
  return input.data?.state ?? null;
}
