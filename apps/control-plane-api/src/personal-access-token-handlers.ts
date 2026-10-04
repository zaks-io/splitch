import {
  boundListRead,
  type ErrorResponse,
  isProvisionalAuthDoor,
  LIST_READ_LIMIT,
  PERSONAL_ACCESS_TOKEN_DEFAULT_TTL_DAYS,
  PERSONAL_ACCESS_TOKEN_MAX_ACTIVE,
  PERSONAL_ACCESS_TOKEN_SECRET_PREFIX,
  type PersonalAccessTokenGrant,
  personalAccessTokenExpired,
  type UserRole,
  userRoleCovers,
} from "@splitch/contracts";
import type { PersonalAccessTokenPatch, PersonalAccessTokenRow, Repository } from "@splitch/db";
import {
  type HandlerArgs,
  type Principal,
  type Registrar,
  renderError,
} from "@splitch/worker-runtime";
import type { Hono } from "hono";
import { randomHex, sha256Hex } from "./credential-cache";
import { objectBody, pathParam } from "./handler-input";
import {
  personalAccessTokenResponse,
  writePersonalAccessTokenCache,
} from "./personal-access-token-store";
import { controlPlaneRoute } from "./routes";
import { makeTokenMembershipAccess, type TokenMembershipAccess } from "./token-membership";

const DAY_MS = 24 * 60 * 60 * 1000;

interface PersonalAccessTokenHandlerDeps {
  repo: Pick<Repository, "personalAccessTokens">;
  membershipAccess: TokenMembershipAccess;
  /** SESSION_STORE: shared with the MCP Worker, which authenticates PATs from it. */
  store?: KVNamespace;
  nowMs?: () => number;
}

/**
 * Personal Access Token management, keyed by the calling user. Mounted on the
 * public bearer door only (never the MCP binding), so a PAT can never manage
 * PATs. The secret is returned only by create and rotate, and only once.
 */
function makePersonalAccessTokenHandlers(deps: PersonalAccessTokenHandlerDeps) {
  const now = () => deps.nowMs?.() ?? Date.now();
  const tokens = deps.repo.personalAccessTokens;

  return {
    async list({ principal }: HandlerArgs<unknown>): Promise<Response> {
      const scanned = await tokens.listForUser(principal.id, { limit: LIST_READ_LIMIT + 1 });
      const nowMs = now();
      return Response.json(
        boundListRead(scanned.map((row) => personalAccessTokenResponse(row, nowMs))),
      );
    },

    async create({ input, principal, requestId }: HandlerArgs<unknown>): Promise<Response> {
      const store = requireStore(deps.store);
      const refused = provisionalRefusal(principal);
      if (refused) return renderError(refused, { requestId });
      const body = objectBody(input);
      const grants = body.grants as PersonalAccessTokenGrant[];
      const nowMs = now();
      const invalid =
        (await grantProblems(deps.membershipAccess, principal.id, grants)) ??
        expiryProblem(body.expiresAt, nowMs);
      if (invalid) return renderError(invalid, { requestId });
      if (
        (await tokens.listActiveForUser(principal.id)).length >= PERSONAL_ACCESS_TOKEN_MAX_ACTIVE
      ) {
        return renderError(
          forbidden(
            `you already hold ${PERSONAL_ACCESS_TOKEN_MAX_ACTIVE} active personal access tokens; revoke one first`,
          ),
          { requestId },
        );
      }

      const secret = newSecret();
      const tokenHash = await sha256Hex(secret);
      const row = await tokens.insert({
        id: `pat_${randomHex(16)}`,
        userId: principal.id,
        name: body.name as string,
        tokenHash,
        grants: JSON.stringify(grants),
        expiresAt: resolveExpiry(body.expiresAt, nowMs),
        createdAt: new Date(nowMs).toISOString(),
      });
      try {
        await writePersonalAccessTokenCache(store, row, tokenHash, false, nowMs);
      } catch (cause) {
        // The MCP door cannot see this token, and its secret is never returned:
        // retire the row so no unusable active token lingers, then fail loud.
        await tokens.revoke(principal.id, row.id, new Date(nowMs).toISOString());
        throw cause;
      }
      return Response.json({ token: personalAccessTokenResponse(row, nowMs), secret });
    },

    async update({ input, principal, requestId }: HandlerArgs<unknown>): Promise<Response> {
      const store = requireStore(deps.store);
      const body = objectBody(input);
      const nowMs = now();
      const invalid = await updateProblems(deps.membershipAccess, principal.id, body, nowMs);
      if (invalid) return renderError(invalid, { requestId });

      const updated = await tokens.update(
        principal.id,
        pathParam(input, "tokenId"),
        updatePatch(body, nowMs),
      );
      if (!updated) return notFound(requestId);
      if ("expiresAt" in body) {
        await writePersonalAccessTokenCache(store, updated, updated.tokenHash, false, nowMs);
      }
      return Response.json(personalAccessTokenResponse(updated, nowMs));
    },

    async rotate({ input, principal, requestId }: HandlerArgs<unknown>): Promise<Response> {
      const store = requireStore(deps.store);
      const tokenId = pathParam(input, "tokenId");
      const current = await tokens.getForUser(principal.id, tokenId);
      if (!current || current.revokedAt !== null) return notFound(requestId);
      const nowMs = now();
      if (personalAccessTokenExpired(current.expiresAt, nowMs)) {
        // A rotated secret would be dead on arrival. Extending is the explicit
        // way to revive an expired token: `tokens update --expires-at …`.
        return renderError(
          forbidden(
            "personal access token has expired; extend it with splitch tokens update --expires-at, then rotate",
          ),
          { requestId },
        );
      }
      const secret = newSecret();
      const tokenHash = await sha256Hex(secret);
      // Tombstone the old secret and publish the new one BEFORE the D1 swap: any
      // failure leaves the token closed (old secret dead, new one never handed
      // out), never with both secrets live.
      await writePersonalAccessTokenCache(store, current, current.tokenHash, true, nowMs);
      await writePersonalAccessTokenCache(store, current, tokenHash, false, nowMs);
      const rotated = await tokens.rotate(principal.id, tokenId, {
        previousHash: current.tokenHash,
        tokenHash,
        rotatedAt: new Date(nowMs).toISOString(),
      });
      if (!rotated) {
        await writePersonalAccessTokenCache(store, current, tokenHash, true, nowMs);
        return notFound(requestId);
      }
      return Response.json({ token: personalAccessTokenResponse(rotated, nowMs), secret });
    },

    async revoke({ input, principal, requestId }: HandlerArgs<unknown>): Promise<Response> {
      const store = requireStore(deps.store);
      const tokenId = pathParam(input, "tokenId");
      const current = await tokens.getForUser(principal.id, tokenId);
      if (!current) return notFound(requestId);
      const nowMs = now();
      // Re-revoking re-writes the tombstone, so a retry heals a failed KV write.
      const revoked =
        current.revokedAt === null
          ? await tokens.revoke(principal.id, tokenId, new Date(nowMs).toISOString())
          : current;
      if (!revoked) return notFound(requestId);
      await writePersonalAccessTokenCache(store, revoked, revoked.tokenHash, true, nowMs);
      return Response.json(personalAccessTokenResponse(revoked, nowMs));
    },

    async revokeAll({ principal }: HandlerArgs<unknown>): Promise<Response> {
      const store = requireStore(deps.store);
      const nowMs = now();
      const revoked = await tokens.revokeAllForUser(principal.id, new Date(nowMs).toISOString());
      await Promise.all(
        revoked.map((row: PersonalAccessTokenRow) =>
          writePersonalAccessTokenCache(store, row, row.tokenHash, true, nowMs),
        ),
      );
      return Response.json({ revokedCount: revoked.length });
    },
  };
}

async function updateProblems(
  access: TokenMembershipAccess,
  userId: string,
  body: Record<string, unknown>,
  nowMs: number,
): Promise<ErrorResponse | null> {
  const grants = body.grants as PersonalAccessTokenGrant[] | undefined;
  if (grants) {
    const problem = await grantProblems(access, userId, grants);
    if (problem) return problem;
  }
  return "expiresAt" in body ? expiryProblem(body.expiresAt, nowMs) : null;
}

function updatePatch(body: Record<string, unknown>, nowMs: number): PersonalAccessTokenPatch {
  return {
    ...(typeof body.name === "string" ? { name: body.name } : {}),
    ...(Array.isArray(body.grants) ? { grants: JSON.stringify(body.grants) } : {}),
    ...("expiresAt" in body ? { expiresAt: resolveExpiry(body.expiresAt, nowMs) } : {}),
  };
}

function newSecret(): string {
  return `${PERSONAL_ACCESS_TOKEN_SECRET_PREFIX}${randomHex(32)}`;
}

function requireStore(store: KVNamespace | undefined): KVNamespace {
  if (!store)
    throw new Error("control-plane-api: SESSION_STORE is required for personal access tokens");
  return store;
}

function resolveExpiry(value: unknown, nowMs: number): string | null {
  if (value === null) return null;
  if (typeof value === "string") return new Date(Date.parse(value)).toISOString();
  return new Date(nowMs + PERSONAL_ACCESS_TOKEN_DEFAULT_TTL_DAYS * DAY_MS).toISOString();
}

function expiryProblem(value: unknown, nowMs: number): ErrorResponse | null {
  if (typeof value !== "string" || Date.parse(value) > nowMs) return null;
  return validation(["expiresAt"], "expiresAt must be in the future (use null for never)");
}

/**
 * A grant must name a membership the caller holds now, with a ceiling at or
 * below the caller's live role. `all` is checked at use time instead, since it
 * spans memberships with different roles.
 */
async function grantProblems(
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

function provisionalRefusal(principal: Principal): ErrorResponse | null {
  if (!isProvisionalAuthDoor(principal.authDoor)) return null;
  return forbidden(
    "a provisional (unclaimed) account cannot create personal access tokens; complete the claim ceremony first",
  );
}

function validation(path: string[], message: string): ErrorResponse {
  return { code: "VALIDATION_ERROR", message, details: { issues: [{ path, message }] } };
}

function forbidden(message: string): ErrorResponse {
  return { code: "FORBIDDEN", message, details: {} };
}

function notFound(requestId: string): Response {
  return renderError(
    {
      code: "CREDENTIAL_NOT_FOUND",
      message: "no active personal access token with that id",
      details: {},
    },
    { requestId },
  );
}

/** Mount the six routes. Callers mount this on the public bearer door only. */
export function mountPersonalAccessTokenRoutes(
  app: Hono,
  registrar: Registrar,
  deps: { repo: Repository; store?: KVNamespace },
): void {
  const handlers = makePersonalAccessTokenHandlers({
    repo: deps.repo,
    membershipAccess: makeTokenMembershipAccess(deps.repo),
    ...(deps.store ? { store: deps.store } : {}),
  });
  registrar.mount(app, controlPlaneRoute("personal_access_tokens_list"), handlers.list);
  registrar.mount(app, controlPlaneRoute("personal_access_tokens_create"), handlers.create);
  registrar.mount(app, controlPlaneRoute("personal_access_tokens_revoke_all"), handlers.revokeAll);
  registrar.mount(app, controlPlaneRoute("personal_access_tokens_update"), handlers.update);
  registrar.mount(app, controlPlaneRoute("personal_access_tokens_rotate"), handlers.rotate);
  registrar.mount(app, controlPlaneRoute("personal_access_tokens_revoke"), handlers.revoke);
}
