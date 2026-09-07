import { remoteJwksSignatureVerifier } from "@splitch/worker-runtime";
import { fetchTrustedJwks } from "./jwks-fetch";

export function verifyRemoteIdentitySignature(jwksUri: string, compactJws: string) {
  return remoteJwksSignatureVerifier(jwksUri, { fetch: fetchTrustedJwks }).verify(compactJws);
}

export function verifySecurityEventSignature(jwksUri: string, compactSet: string) {
  return remoteJwksSignatureVerifier(jwksUri, {
    fetch: fetchTrustedJwks,
    algorithms: ["ES256", "RS256"],
  }).verify(compactSet);
}
