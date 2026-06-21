import type { HealthResponse } from "@splitch/contracts";
import { HealthResponseSchema } from "@splitch/contracts";

export interface ControlPlaneSdkOptions {
  readonly baseUrl: string;
  readonly fetch?: typeof fetch;
}

export interface ControlPlaneSdk {
  health(): Promise<HealthResponse>;
}

export function createControlPlaneSdk(options: ControlPlaneSdkOptions): ControlPlaneSdk {
  const requestFetch = options.fetch ?? fetch;
  const baseUrl = new URL(options.baseUrl);

  return {
    async health() {
      const response = await requestFetch(new URL("/health", baseUrl));

      if (!response.ok) {
        throw new Error(`splitch health check failed: ${response.status}`);
      }

      return HealthResponseSchema.parse(await response.json());
    },
  };
}
