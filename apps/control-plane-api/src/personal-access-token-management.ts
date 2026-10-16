import {
  type ErrorResponse,
  PERSONAL_ACCESS_TOKEN_DEFAULT_TTL_DAYS,
  type PersonalAccessTokenGrant,
  PersonalAccessTokenGrantsSchema,
  personalAccessTokenStepUpReason,
  type UserRole,
  userRoleCovers,
} from "@splitch/contracts";
import type { PersonalAccessTokenPatch, PersonalAccessTokenRow } from "@splitch/db";
import { type Principal, renderError } from "@splitch/worker-runtime";
import type { TokenMembershipAccess } from "./token-membership";

const DAY_MS = 24 * 60 * 60 * 1000;
interface PersonalAccessTokenManagementDeps {
  membershipAccess: TokenMembershipAccess;
  nowMs?: () => number;
}

export async function authorizeIssuance(
  deps: PersonalAccessTokenManagementDeps,
  principal: Principal,
  operation: "create" | "update" | "rotate",
  body: Record<string, unknown>,
  current?: PersonalAccessTokenRow,
) {
  const memberships = await deps.membershipAccess.resolve(principal.id);
  const input = {
    operation,
    scopes: principal.scopes,
    authorization: principal.authorization,
    apps: memberships.apps,
    current: current
      ? {
          grants: PersonalAccessTokenGrantsSchema.parse(JSON.parse(current.grants)),
          expiresAt: current.expiresAt,
        }
      : undefined,
    grants: body.grants as PersonalAccessTokenGrant[] | undefined,
    expiresAt: body.expiresAt as string | null | undefined,
  };
  const cleanup =
    operation === "update" && personalAccessTokenStepUpReason({ ...input, scopes: [] }) === null;
  if (!cleanup) {
    const refused = personalAccessTokenManagementRefusal(principal);
    if (refused) return refused.message;
  }
  const reason = personalAccessTokenStepUpReason(input);
  const approval =
    principal.authDoor === "device_flow" ? principal.personalAccessTokenStepUp : undefined;
  if (reason && !approval)
    return `${reason}; rerun the same splitch tokens command to approve in the browser`;
  return {
    cleanup,
    approval: approval
      ? {
          jti: approval.jti,
          consumedAt: new Date(deps.nowMs?.() ?? Date.now()).toISOString(),
          expiresAt: new Date(approval.expiresAt * 1000).toISOString(),
        }
      : undefined,
  };
}

export async function updateProblems(
  access: TokenMembershipAccess,
  userId: string,
  body: Record<string, unknown>,
  nowMs: number,
  cleanup: boolean,
): Promise<ErrorResponse | null> {
  const grants = body.grants as PersonalAccessTokenGrant[] | undefined;
  // Cleanup reduces stored authority even after membership changes. PAT usage
  // still intersects the remaining grants with live membership on every call.
  if (grants && !cleanup) {
    const problem = await grantProblems(access, userId, grants);
    if (problem) return problem;
  }
  return "expiresAt" in body ? expiryProblem(body.expiresAt, nowMs) : null;
}

export function updatePatch(
  body: Record<string, unknown>,
  nowMs: number,
): PersonalAccessTokenPatch {
  return {
    ...(typeof body.name === "string" ? { name: body.name } : {}),
    ...(Array.isArray(body.grants) ? { grants: JSON.stringify(body.grants) } : {}),
    ...("expiresAt" in body ? { expiresAt: resolveExpiry(body.expiresAt, nowMs) } : {}),
  };
}

export function requireStore(store: KVNamespace | undefined): KVNamespace {
  if (!store)
    throw new Error("control-plane-api: SESSION_STORE is required for personal access tokens");
  return store;
}

export function resolveExpiry(value: unknown, nowMs: number): string | null {
  if (value === null) return null;
  if (typeof value === "string") return new Date(Date.parse(value)).toISOString();
  return new Date(nowMs + PERSONAL_ACCESS_TOKEN_DEFAULT_TTL_DAYS * DAY_MS).toISOString();
}

export function expiryProblem(value: unknown, nowMs: number): ErrorResponse | null {
  if (typeof value !== "string" || Date.parse(value) > nowMs) return null;
  return validation(["expiresAt"], "expiresAt must be in the future (use null for never)");
}

/**
 * A grant must name a membership the caller holds now, with a ceiling at or
 * below the caller's live role. `all` is checked at use time instead, since it
 * spans memberships with different roles.
 */
export async function grantProblems(
  access: TokenMembershipAccess,
  userId: string,
  grants: readonly PersonalAccessTokenGrant[],
): Promise<ErrorResponse | null> {
  const memberships = await access.resolve(userId);
  const roles = new Map<string, UserRole>([
    ...memberships.organizations.map((org) => [`org:${org.id}`, org.role] as const),
    ...memberships.apps.map((app) => [`app:${app.id}`, app.role] as const),
  ]);
  for (const [index, grant] of grants.entries()) {
    if (grant.target === "all") continue;
    const role = roles.get(grant.target);
    if (!role) {
      return validation(
        ["grants", String(index), "target"],
        `you are not a member of ${grant.target}`,
      );
    }
    if (!userRoleCovers(role, grant.role)) {
      return validation(
        ["grants", String(index), "role"],
        `grant role ${grant.role} exceeds your ${role} role on ${grant.target}`,
      );
    }
  }
  return null;
}

export function personalAccessTokenManagementRefusal(principal: Principal): ErrorResponse | null {
  if (principal.authDoor === "device_flow" || principal.authDoor === "client_credentials") {
    return null;
  }
  return forbidden(
    "creating, updating, or rotating personal access tokens requires device_flow or client_credentials authentication; sign in with splitch login",
  );
}

function validation(path: string[], message: string): ErrorResponse {
  return { code: "VALIDATION_ERROR", message, details: { issues: [{ path, message }] } };
}

export function forbidden(message: string): ErrorResponse {
  return { code: "FORBIDDEN", message, details: {} };
}

export function notFound(requestId: string): Response {
  return renderError(
    {
      code: "CREDENTIAL_NOT_FOUND",
      message: "no active personal access token with that id",
      details: {},
    },
    { requestId },
  );
}

export function isActivePersonalAccessToken(
  row: PersonalAccessTokenRow | null,
): row is PersonalAccessTokenRow {
  return row !== null && row.revokedAt === null;
}
