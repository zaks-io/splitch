export const MEMBERSHIP_WIDE_READ_AUTHORIZATION = "membership-wide-read" as const;
export const PAT_MANAGEMENT_AUTHORIZATION = "pat-management" as const;

export type AccessTokenAuthorization =
  | typeof MEMBERSHIP_WIDE_READ_AUTHORIZATION
  | typeof PAT_MANAGEMENT_AUTHORIZATION;

export function accessTokenAuthorizationFromClaim(
  claim: unknown,
): AccessTokenAuthorization | undefined {
  return claim === MEMBERSHIP_WIDE_READ_AUTHORIZATION || claim === PAT_MANAGEMENT_AUTHORIZATION
    ? claim
    : undefined;
}
