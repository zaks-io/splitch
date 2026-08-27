import { MCP_DELEGATION_HEADER } from "@splitch/contracts";

/**
 * Credential-bearing control-plane requests must not follow 3xx responses.
 * Default fetch replays Authorization (and any other headers) onto Location.
 */
export function withoutCredentialRedirect(fetchImpl: typeof fetch): typeof fetch {
  const guarded: typeof fetch = (input, init) => {
    if (!requestCarriesCredentials(input, init)) {
      return fetchImpl(input, init);
    }
    return fetchImpl(input, { ...init, redirect: "error" });
  };
  return guarded;
}

export function requestCarriesCredentials(input: RequestInfo | URL, init?: RequestInit): boolean {
  const headers = mergeRequestHeaders(input, init);
  return (
    hasCredentialHeader(headers, "authorization") ||
    hasCredentialHeader(headers, MCP_DELEGATION_HEADER)
  );
}

function mergeRequestHeaders(input: RequestInfo | URL, init?: RequestInit): Headers {
  const headers = new Headers(input instanceof Request ? input.headers : undefined);
  if (init?.headers) {
    new Headers(init.headers).forEach((value, name) => {
      headers.set(name, value);
    });
  }
  return headers;
}

function hasCredentialHeader(headers: Headers, name: string): boolean {
  const value = headers.get(name);
  return value !== null && value.length > 0;
}
