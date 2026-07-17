import { decodeJwt, fetchJwks, verifySignature } from "./jwks";
import { OAuthError } from "./oauth-errors";

export interface WorkOsAccessTokenVerifier {
  verify(token: string, nowSeconds: number): Promise<{ userId: string }>;
}

export function makeWorkOsAccessTokenVerifier(input: {
  jwksUri: string;
  issuer: string;
  audience: string;
}): WorkOsAccessTokenVerifier {
  return {
    async verify(token, nowSeconds) {
      const decoded = decodeJwt(token);
      await verifySignature(decoded, await fetchJwks(input.jwksUri));
      const { sub, iss, aud, exp } = decoded.payload;
      if (
        typeof sub !== "string" ||
        sub.length === 0 ||
        iss !== input.issuer ||
        !matchesAudience(aud, input.audience) ||
        typeof exp !== "number" ||
        exp <= nowSeconds
      ) {
        throw new OAuthError(
          "invalid_token",
          "WorkOS access token has invalid issuer, audience, subject, or expiry",
        );
      }
      return { userId: sub };
    },
  };
}

function matchesAudience(aud: unknown, expected: string) {
  return aud === expected || (Array.isArray(aud) && aud.includes(expected));
}
