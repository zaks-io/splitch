import {
  compactVerify,
  createRemoteJWKSet,
  customFetch,
  errors,
  type FetchImplementation,
  type RemoteJWKSet,
} from "jose";

const MAX_REMOTE_JWKS_RESOLVERS = 32;
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
 * Process-local remote JWKS resolvers keyed only by their trusted URI. A fresh
 * isolate refetches, which affects latency but never verification correctness.
 * The bound prevents a trusted-IdP catalog from growing isolate memory forever.
 */
const remoteResolvers = new Map<string, RemoteJWKSet>();

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
  const key = new URL(jwksUri).href;
  const existing = remoteResolvers.get(key);
  if (existing) {
    remoteResolvers.delete(key);
    remoteResolvers.set(key, existing);
    return existing;
  }

  const resolver = createRemoteJWKSet(
    new URL(key),
    fetchImpl === undefined ? undefined : { [customFetch]: fetchImpl },
  );
  remoteResolvers.set(key, resolver);
  if (remoteResolvers.size > MAX_REMOTE_JWKS_RESOLVERS) {
    const oldest = remoteResolvers.keys().next().value;
    if (oldest !== undefined) {
      remoteResolvers.delete(oldest);
    }
  }
  return resolver;
}
