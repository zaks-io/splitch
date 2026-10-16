import type { AccessTokenAuthorization } from "./access-token-authorization";
import type { UserRole } from "./leaf-schemas-runtime";
import { type PersonalAccessTokenGrant, userRoleCovers } from "./personal-access-tokens";

export const PERSONAL_ACCESS_TOKEN_AUTHORIZATION_HEADER = "Splitch-PAT-Authorization";
export const PERSONAL_ACCESS_TOKEN_STEP_UP_TTL_SECONDS = 300;

interface TokenAuthority {
  grants: readonly PersonalAccessTokenGrant[];
  expiresAt: string | null;
}

export interface PersonalAccessTokenStepUpInput {
  operation: "create" | "update" | "rotate" | "list" | "revoke" | "revoke-all";
  grants?: readonly PersonalAccessTokenGrant[];
  expiresAt?: string | null;
  current?: TokenAuthority;
  scopes: readonly string[];
  authorization?: AccessTokenAuthorization;
  apps?: readonly { id: string; organizationId: string }[];
}

function targetCovers(
  held: string,
  target: string,
  apps: PersonalAccessTokenStepUpInput["apps"],
): boolean {
  if (held === "all" || held === target) return true;
  return (
    held.startsWith("org:") &&
    target.startsWith("app:") &&
    apps?.some((app) => `app:${app.id}` === target && `org:${app.organizationId}` === held) === true
  );
}

function grantsCover(
  held: readonly PersonalAccessTokenGrant[],
  requested: readonly PersonalAccessTokenGrant[],
  apps: PersonalAccessTokenStepUpInput["apps"],
): boolean {
  return requested.every((grant) =>
    held.some(
      (prior) =>
        targetCovers(prior.target, grant.target, apps) &&
        userRoleCovers(prior.role, grant.role) &&
        grant.permissions.every((permission) => prior.permissions.includes(permission)),
    ),
  );
}

function expiryRank(expiry: string | null | undefined): number {
  return expiry == null ? Number.POSITIVE_INFINITY : Date.parse(expiry);
}

function resultingAuthority(input: PersonalAccessTokenStepUpInput) {
  if (input.operation !== "create" && !input.current)
    throw new Error("PAT management requires the stored token");
  const grants = input.grants ?? input.current?.grants;
  if (!grants?.length) throw new Error("PAT management requires resulting grants");
  const expiresAt = input.expiresAt === undefined ? input.current?.expiresAt : input.expiresAt;
  return { grants, expiresAt };
}

function updateDisposition(
  input: PersonalAccessTokenStepUpInput,
  result: ReturnType<typeof resultingAuthority>,
): "cleanup" | "widening" | null {
  const current = input.current;
  if (input.operation !== "update" || !current) return null;
  if (!grantsCover(current.grants, result.grants, input.apps)) return "widening";
  const nextExpiry = expiryRank(result.expiresAt);
  const priorExpiry = expiryRank(current.expiresAt);
  const reduced =
    !grantsCover(result.grants, current.grants, input.apps) || nextExpiry < priorExpiry;
  return reduced && nextExpiry <= priorExpiry ? "cleanup" : null;
}

function scopeCoversGrant(
  input: PersonalAccessTokenStepUpInput,
  grant: PersonalAccessTokenGrant,
): boolean {
  if (grant.permissions.length > 0 && input.authorization === "membership-wide-read") return false;
  return input.scopes.some((scope) => {
    const match = /^(app:[^:]+|org:[^:]+):(member|admin|owner)$/.exec(scope);
    return (
      match !== null &&
      targetCovers(match[1] as string, grant.target, input.apps) &&
      userRoleCovers(match[2] as UserRole, grant.role)
    );
  });
}

/** Resolve only relationships that can change the cleanup or session-coverage decision. */
export function personalAccessTokenAppOrganizationLookups(
  input: PersonalAccessTokenStepUpInput,
): string[] {
  const { grants, expiresAt } = resultingAuthority(input);
  const apps = grants.filter((grant) => grant.target.startsWith("app:"));
  const ids = (candidates: readonly PersonalAccessTokenGrant[]) => [
    ...new Set(candidates.map((grant) => grant.target.slice(4))),
  ];
  if (input.operation === "update" && input.current) {
    const current = input.current;
    const uncovered = apps.filter((grant) => !grantsCover(current.grants, [grant], input.apps));
    if (uncovered.length > 0) {
      return current.grants.some((grant) => grant.target.startsWith("org:")) ? ids(uncovered) : [];
    }
  } else if (expiresAt === null || grants.some((grant) => grant.target === "all")) {
    return [];
  }
  if (!input.scopes.some((scope) => /^org:[^:]+:(member|admin|owner)$/.test(scope))) return [];
  return ids(apps.filter((grant) => !scopeCoversGrant(input, grant)));
}

/** One policy for both the CLI prompt and the server's issuance guard. */
export function personalAccessTokenStepUpReason(
  input: PersonalAccessTokenStepUpInput,
): string | null {
  if (["list", "revoke", "revoke-all"].includes(input.operation)) return null;
  const result = resultingAuthority(input);
  const disposition = updateDisposition(input, result);
  if (disposition === "cleanup") return null;
  if (disposition === "widening") return "the update widens the stored token's grants";
  if (result.expiresAt === null) return "permanent token issuance requires fresh approval";
  if (result.grants.some((grant) => grant.target === "all"))
    return "all-memberships authority requires fresh approval";
  if (!result.grants.every((grant) => scopeCoversGrant(input, grant)))
    return "the requested authority exceeds this session's access token";
  return null;
}

export function personalAccessTokenNeedsStepUp(input: PersonalAccessTokenStepUpInput): boolean {
  return personalAccessTokenStepUpReason(input) !== null;
}
