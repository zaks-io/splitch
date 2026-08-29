export const MEMBERSHIP_WIDE_READ_AUTHORIZATION = "membership-wide-read" as const;

export type AccessTokenAuthorization = typeof MEMBERSHIP_WIDE_READ_AUTHORIZATION;

export function accessTokenAuthorizationFromClaim(
  claim: unknown,
): AccessTokenAuthorization | undefined {
  return claim === MEMBERSHIP_WIDE_READ_AUTHORIZATION ? claim : undefined;
}
