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
  // `undefined` inherits whatever the hc client was constructed with; `null`
  // must actively CLEAR a client-baked Authorization header (hono deep-merges
  // per-request options over construction options, so an empty `{}` would leave
  // the baked header in place). An empty value overrides it to "no credential".
  if (options.authorization === undefined) {
    return {};
  }
  return { headers: { authorization: options.authorization ?? "" } };
}

/**
 * Join a route path onto a base URL the way hono `hc` does (mergePath):
 * concatenation, preserving any path PREFIX on the base. `new URL(path, base)`
 * would instead REPLACE the base path for an absolute `path`, so a
 * prefix-mounted `baseUrl` (e.g. `https://host/control-plane`) would silently
 * target the wrong server for `health()` and the MCP adapter.
 */
export function resolveControlPlaneUrl(baseUrl: URL, path: string): URL {
  const basePath = baseUrl.pathname.replace(/\/+$/, "");
  const suffix = path.startsWith("/") ? path : `/${path}`;
  const url = new URL(baseUrl.toString());
  url.pathname = `${basePath}${suffix}`;
  return url;
}
