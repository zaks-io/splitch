import { PERSONAL_ACCESS_TOKEN_ID_PATTERN } from "./personal-access-tokens";

/**
 * The Personal Access Token half of the MCP delegation credential, split out of
 * mcp-delegation.ts. The door, the token id, and the secret's SHA-256 travel
 * together, and only on a live-membership credential.
 */

const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

interface PersonalAccessTokenDelegationFields {
  personalAccessTokenId?: string;
  personalAccessTokenHash?: string;
}

export function personalAccessTokenFields(
  source: PersonalAccessTokenDelegationFields,
): PersonalAccessTokenDelegationFields {
  if (!source.personalAccessTokenId || !source.personalAccessTokenHash) return {};
  return {
    personalAccessTokenId: source.personalAccessTokenId,
    personalAccessTokenHash: source.personalAccessTokenHash,
  };
}

/**
 * The PAT door and the token id travel together, and only on a live-membership
 * credential: a PAT carries no scopes of its own, so a PAT delegation without
 * live resolution, or a token id on any other door, is a forgery signal.
 */
export function personalAccessTokenShapeValid(value: {
  authDoor?: unknown;
  liveMembership?: unknown;
  personalAccessTokenId?: unknown;
  personalAccessTokenHash?: unknown;
}): boolean {
  if (value.authDoor !== "personal_access_token") {
    return value.personalAccessTokenId === undefined && value.personalAccessTokenHash === undefined;
  }
  return (
    value.liveMembership === true &&
    typeof value.personalAccessTokenId === "string" &&
    PERSONAL_ACCESS_TOKEN_ID_PATTERN.test(value.personalAccessTokenId) &&
    typeof value.personalAccessTokenHash === "string" &&
    SHA256_HEX_PATTERN.test(value.personalAccessTokenHash)
  );
}
