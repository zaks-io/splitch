import {
  createControlPlaneClientApp,
  type ControlPlaneClientApp,
} from "@splitch/contracts";
import { hc } from "hono/client";
import type { ControlPlaneOperationOptions } from "./operation-result";

export interface ControlPlaneHcOptions {
  readonly baseUrl: string;
  readonly fetch?: typeof fetch;
  readonly authorization?: string | null;
}

/** Hono `hc` client over the registry-derived emit-only app type. */
export type ControlPlaneHcClient = ReturnType<typeof createControlPlaneHcClient>;

export function createControlPlaneHcClient(options: ControlPlaneHcOptions) {
  const app = createControlPlaneClientApp();
  const headers = options.authorization ? { authorization: options.authorization } : undefined;

  return hc<ControlPlaneClientApp>(options.baseUrl, {
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

export function hcRequestOptions(
  options: ControlPlaneHcOptions,
): { headers?: Record<string, string> } {
  return options.authorization ? { headers: { authorization: options.authorization } } : {};
}
