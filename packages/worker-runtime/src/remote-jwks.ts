import {
  compactVerify,
  createRemoteJWKSet,
  customFetch,
  errors,
  type FetchImplementation,
  type RemoteJWKSet,
} from "jose";

const MAX_REMOTE_JWKS_RESOLVERS = 32;
export const JWKS_SHARED_CACHE_TTL_SECONDS = 300;
const rejectedCredentialCodes = new Set([
  "ERR_JOSE_ALG_NOT_ALLOWED",
  "ERR_JWKS_NO_MATCHING_KEY",
  "ERR_JWS_INVALID",
  "ERR_JWS_SIGNATURE_VERIFICATION_FAILED",
]);

export interface RemoteJwksSignatureVerifier {
  verify(compactJws: string): Promise<boolean>;
}

export interface RemoteJwksSignatureVerifierOptions {
  fetch?: FetchImplementation;
}

/**
 * Process-local remote JWKS resolvers keyed by normalized URI and fetch
 * implementation. The default `fetch` shares one partition so first-party
 * callers keep a stable cache. A custom fetch (tenant JWKS policy) must not
 * inherit a resolver that was created with a different transport.
 */
const remoteResolvers = new Map<string, RemoteJWKSet>();
const fetchPartitions = new WeakMap<FetchImplementation, string>();
let nextFetchPartition = 1;

// Five minutes collapses bursty CLI and Control Panel auth into one fetch per colo. It accepts the
// same key-rotation propagation window; emergency rotation requires purging the JWKS URL. Unknown
// kid requests deliberately do not bypass this cache because that would amplify attacker traffic.
export const fetchSharedJwks: FetchImplementation = (url, options) => {
  return fetch(url, {
    ...options,
    cf: {
      cacheEverything: true,
      // Only 200 is cacheable: jose rejects every other status, including the
      // rest of 2xx, so caching a 204 would wedge the whole colo on a response
      // that is already a fault instead of letting the next request refetch.
      cacheTtlByStatus: {
        "200": JWKS_SHARED_CACHE_TTL_SECONDS,
        "201-299": 0,
        "300-399": 0,
        "400-599": 0,
      },
    },
  });
};

/**
 * Reuse jose's Cloudflare-aware remote resolver. It caches parsed keys, bounds
 * refreshes, refreshes after a new `kid`, and fails loud on transport faults.
 */
export function remoteJwksSignatureVerifier(
  jwksUri: string,
  options?: RemoteJwksSignatureVerifierOptions,
): RemoteJwksSignatureVerifier {
  const resolver = remoteResolver(jwksUri, options?.fetch);
  return {
    async verify(compactJws) {
      try {
        await compactVerify(compactJws, resolver, { algorithms: ["RS256"] });
        return true;
      } catch (cause) {
        if (cause instanceof errors.JOSEError && rejectedCredentialCodes.has(cause.code)) {
          return false;
        }
        throw cause;
      }
    },
  };
}

function remoteResolver(jwksUri: string, fetchImpl?: FetchImplementation): RemoteJWKSet {
  const href = new URL(jwksUri).href;
  const key = `${fetchPartition(fetchImpl)}\0${href}`;
  const existing = remoteResolvers.get(key);
  if (existing) {
    remoteResolvers.delete(key);
    remoteResolvers.set(key, existing);
    return existing;
  }

  const transport = fetchImpl ?? fetchSharedJwks;
  const resolver = createRemoteJWKSet(new URL(href), { [customFetch]: transport });
  remoteResolvers.set(key, resolver);
  if (remoteResolvers.size > MAX_REMOTE_JWKS_RESOLVERS) {
    const oldest = remoteResolvers.keys().next().value;
    if (oldest !== undefined) {
      remoteResolvers.delete(oldest);
    }
  }
  return resolver;
}

function fetchPartition(fetchImpl?: FetchImplementation): string {
  if (fetchImpl === undefined) return "default";
  const existing = fetchPartitions.get(fetchImpl);
  if (existing !== undefined) return existing;
  const id = `custom:${nextFetchPartition}`;
  nextFetchPartition += 1;
  fetchPartitions.set(fetchImpl, id);
  return id;
}
