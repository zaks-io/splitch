import type { EnvironmentExposureStatusCleanup } from "../src/environment-exposure-status-cleanup";

export const noOpExposureStatusCleanup: EnvironmentExposureStatusCleanup = {
  delete: async () => undefined,
};
