import {
  type ErrorResponse,
  PERSONAL_ACCESS_TOKEN_DEFAULT_TTL_DAYS,
  PERSONAL_ACCESS_TOKEN_STEP_UP_CHALLENGE,
  type PersonalAccessTokenGrant,
  PersonalAccessTokenGrantsSchema,
  type PersonalAccessTokenStepUpInput,
  personalAccessTokenAppOrganizationLookups,
  personalAccessTokenStepUpReason,
  type UserRole,
  userRoleCovers,
} from "@splitch/contracts";
import type {
  PersonalAccessTokenPatch,
  PersonalAccessTokenRow,
  PersonalAccessTokenStepUpUse,
  Repository,
} from "@splitch/db";
import { type Principal, renderError } from "@splitch/worker-runtime";
import type { TokenMembershipAccess } from "./token-membership";

const DAY_MS = 24 * 60 * 60 * 1000;
interface PersonalAccessTokenManagementDeps {
  repo: Pick<Repository, "identity">;
  membershipAccess: TokenMembershipAccess;
  nowMs?: () => number;
}

interface IssuanceRefusal {
  refusal: ErrorResponse;
  defaultHeaders: Record<string, string>;
}

export function issuanceRefusalResponse(issuance: IssuanceRefusal, requestId: string): Response {
  return renderError(issuance.refusal, { requestId, defaultHeaders: issuance.defaultHeaders });
}

export async function authorizeIssuance(
  deps: PersonalAccessTokenManagementDeps,
  principal: Principal,
  operation: "create" | "update" | "rotate",
  body: Record<string, unknown>,
  current?: PersonalAccessTokenRow,
): Promise<
  IssuanceRefusal | { cleanup: boolean; approval: PersonalAccessTokenStepUpUse | undefined }
> {
  const memberships = await deps.membershipAccess.resolve(principal.id);
  const input = {
    operation,
    scopes: principal.scopes,
    authorization: principal.authorization,
    apps: memberships.apps.map(({ id, organizationId }) => ({ id, organizationId })),
    current: current
      ? {
          grants: PersonalAccessTokenGrantsSchema.parse(JSON.parse(current.grants)),
          expiresAt: current.expiresAt,
        }
      : undefined,
    grants: body.grants as PersonalAccessTokenGrant[] | undefined,
    expiresAt: body.expiresAt as string | null | undefined,
  };
  input.apps.push(...(await canonicalCleanupApps(deps, input)));
  const cleanup =
    operation === "update" && personalAccessTokenStepUpReason({ ...input, scopes: [] }) === null;
  if (!cleanup) {
    const refused = personalAccessTokenManagementRefusal(principal);
    if (refused) return { refusal: refused, defaultHeaders: {} };
  }
  const reason = personalAccessTokenStepUpReason(input);
  const approval =
    principal.authDoor === "device_flow" ? principal.personalAccessTokenStepUp : undefined;
  if (reason && !approval) {
    return {
      refusal: forbidden(
        `${reason}; rerun the same splitch tokens command to approve in the browser`,
      ),
      // Released SDKs require empty FORBIDDEN details. Challenge in the header
      // so their existing error body and useful human message remain valid.
      defaultHeaders: { "WWW-Authenticate": PERSONAL_ACCESS_TOKEN_STEP_UP_CHALLENGE },
    };
  }
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

async function canonicalCleanupApps(
  deps: PersonalAccessTokenManagementDeps,
  input: PersonalAccessTokenStepUpInput,
): Promise<{ id: string; organizationId: string }[]> {
  if (input.operation !== "update") return [];
  // Cleanup depends on stored authority and canonical identity, even when the
  // caller can no longer discover an App through its live memberships.
  const appIds = personalAccessTokenAppOrganizationLookups({ ...input, scopes: [], apps: [] });
  const apps: { id: string; organizationId: string }[] = [];
  for (const appId of appIds) {
    const app = await deps.repo.identity.getApp(appId);
    if (app) apps.push({ id: app.id, organizationId: app.organizationId });
  }
  return apps;
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
