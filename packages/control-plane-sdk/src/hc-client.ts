import type {
  ExperimentsControlPlaneClientApp,
  FlagsControlPlaneClientApp,
} from "@splitch/contracts/client-app";
import { hc } from "hono/client";
import type { ControlPlaneOperationOptions } from "./operation-result";

export interface ControlPlaneHcOptions {
  readonly baseUrl: string;
  readonly fetch?: typeof fetch;
  readonly authorization?: string | null;
}

/** Hono `hc` client over the flags emit-only app type. */
export type FlagsHcClient = ReturnType<typeof createFlagsHcClient>;

/** Hono `hc` client over the experiments emit-only app type. */
export type ExperimentsHcClient = ReturnType<typeof createExperimentsHcClient>;

export function createFlagsHcClient(options: ControlPlaneHcOptions) {
  const headers = options.authorization ? { authorization: options.authorization } : undefined;

  return hc<FlagsControlPlaneClientApp>(options.baseUrl, {
    fetch: options.fetch,
    ...(headers ? { headers } : {}),
  });
}

export function createExperimentsHcClient(options: ControlPlaneHcOptions) {
  const headers = options.authorization ? { authorization: options.authorization } : undefined;

  return hc<ExperimentsControlPlaneClientApp>(options.baseUrl, {
    fetch: options.fetch,
    ...(headers ? { headers } : {}),
  });
}

export function withAuthorization(
  options: ControlPlaneHcOptions,
  callOptions?: ControlPlaneOperationOptions,
): ControlPlaneHcOptions {
  if (callOptions?.authorization === undefined) {
    return options;
  }
  return { ...options, authorization: callOptions.authorization };
}

export function hcRequestOptions(options: ControlPlaneHcOptions): {
  headers?: Record<string, string>;
} {
  return options.authorization ? { headers: { authorization: options.authorization } } : {};
}
