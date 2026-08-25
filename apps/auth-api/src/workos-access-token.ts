import { remoteJwksSignatureVerifier } from "@splitch/worker-runtime";
import { decodeJwt } from "./jwks";
import { OAuthError } from "./oauth-errors";

export interface WorkOsAccessTokenVerifier {
  verify(token: string, nowSeconds: number): Promise<{ userId: string }>;
}

export function makeWorkOsAccessTokenVerifier(input: {
  jwksUri: string;
  issuer: string;
  clientId: string;
}): WorkOsAccessTokenVerifier {
  const signatures = remoteJwksSignatureVerifier(input.jwksUri);
  return {
    async verify(token, nowSeconds) {
      const decoded = decodeJwt(token);
      if (!(await signatures.verify(token))) {
        throw new OAuthError("invalid_token", "WorkOS access token signature is invalid");
      }
      const { sub, iss, client_id: clientId, exp } = decoded.payload;
      if (
        typeof sub !== "string" ||
        sub.length === 0 ||
        iss !== input.issuer ||
        clientId !== input.clientId ||
        typeof exp !== "number" ||
        exp <= nowSeconds
      ) {
        throw new OAuthError(
          "invalid_token",
          "WorkOS access token has invalid issuer, client, subject, or expiry",
        );
      }
      return { userId: sub };
    },
  };
}
