import {
  type AccessTokenAuthorization,
  MEMBERSHIP_WIDE_READ_AUTHORIZATION,
  PAT_MANAGEMENT_AUTHORIZATION,
  PERSONAL_ACCESS_TOKEN_STEP_UP_TTL_SECONDS,
} from "@splitch/contracts";
import { OAuthError } from "./oauth-errors";

export interface AccessTokenClaims {
  typ: "access_token";
  sub: string;
  iss: string;
  aud: string;
  iat: number;
  exp: number;
  scopes: string[];
  auth_door: "id_jag" | "anonymous" | "device_flow" | "client_credentials";
  demo_expires_at?: string;
  authorization?: AccessTokenAuthorization;
  jti?: string;
}

export function assertIdentityExchangeAuthorization(
  authorization: AccessTokenAuthorization | undefined,
): void {
  if (authorization === PAT_MANAGEMENT_AUTHORIZATION) {
    throw new OAuthError(
      "invalid_request",
      "PAT management authorization requires a fresh device approval",
    );
  }
}

export function accessTokenAuthorizationClaims(
  authorization: AccessTokenAuthorization | undefined,
  scopes: readonly string[],
  authDoor: AccessTokenClaims["auth_door"],
  audience: string,
  controlPlaneAudience: string,
  nowSeconds: number,
): { authorization?: AccessTokenAuthorization; exp?: number; jti?: string } {
  if (authorization === MEMBERSHIP_WIDE_READ_AUTHORIZATION && scopes.length !== 0) {
    throw new Error("membership-wide read tokens cannot carry selector scopes");
  }
  if (authorization === PAT_MANAGEMENT_AUTHORIZATION) {
    if (authDoor !== "device_flow" || scopes.length !== 0 || audience !== controlPlaneAudience) {
      throw new Error("PAT management tokens require device approval without selector scopes");
    }
    return {
      authorization,
      exp: nowSeconds + PERSONAL_ACCESS_TOKEN_STEP_UP_TTL_SECONDS,
      jti: crypto.randomUUID(),
    };
  }
  return authorization ? { authorization } : {};
}
