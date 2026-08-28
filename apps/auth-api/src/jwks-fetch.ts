import { parseJwksUrl } from "./jwks-url";

export type JwksFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

/**
 * Fetch a tenant JWKS through the Workers HTTP egress path. The Auth Worker
 * enables `global_fetch_strictly_public`, so the runtime binds this request to
 * public Internet reachability after DNS resolution.
 */
export async function fetchTrustedJwks(
  url: string | URL,
  init: RequestInit,
  deps: { fetcher?: JwksFetch } = {},
): Promise<Response> {
  const parsed = parseJwksUrl(String(url));
  if (!parsed.ok) {
    throw new Error(parsed.error);
  }
  return (deps.fetcher ?? fetch)(parsed.href, { ...init, redirect: "manual" });
}
