import {
  boundListRead,
  LIST_READ_LIMIT,
  PERSONAL_ACCESS_TOKEN_MAX_ACTIVE,
  PERSONAL_ACCESS_TOKEN_SECRET_PREFIX,
  type PersonalAccessTokenGrant,
  personalAccessTokenExpired,
} from "@splitch/contracts";
import {
  PersonalAccessTokenClaimRefused,
  type PersonalAccessTokenRow,
  type Repository,
} from "@splitch/db";
import { type HandlerArgs, type Registrar, renderError } from "@splitch/worker-runtime";
import type { Hono } from "hono";
import { randomHex, sha256Hex } from "./credential-cache";
import { objectBody, pathParam } from "./handler-input";
import {
  authorizeIssuance,
  expiryProblem,
  forbidden,
  grantProblems,
  isActivePersonalAccessToken,
  issuanceRefusalResponse,
  notFound,
  personalAccessTokenManagementRefusal,
  requireStore,
  resolveExpiry,
  updatePatch,
  updateProblems,
} from "./personal-access-token-management";
import { rotatePersonalAccessToken } from "./personal-access-token-rotation";
import {
  personalAccessTokenResponse,
  writePersonalAccessTokenCache,
} from "./personal-access-token-store";
import { controlPlaneRoute } from "./routes";
import { makeTokenMembershipAccess, type TokenMembershipAccess } from "./token-membership";

interface PersonalAccessTokenHandlerDeps {
  repo: Pick<Repository, "personalAccessTokens" | "identity">;
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

      const issuance = await authorizeIssuance(deps, principal, "create", body);
      if ("refusal" in issuance) return issuanceRefusalResponse(issuance, requestId);
      const secret = newSecret();
      const tokenHash = await sha256Hex(secret);
      const row = await tokens.insertAuthorized(
        {
          id: `pat_${randomHex(16)}`,
          userId: principal.id,
          name: body.name as string,
          tokenHash,
          grants: JSON.stringify(grants),
          expiresAt: resolveExpiry(body.expiresAt, nowMs),
          createdAt: new Date(nowMs).toISOString(),
        },
        issuance.approval,
      );
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
      const current = await tokens.getForUser(principal.id, pathParam(input, "tokenId"));
      if (!isActivePersonalAccessToken(current)) return notFound(requestId);
      const issuance = await authorizeIssuance(deps, principal, "update", body, current);
      if ("refusal" in issuance) return issuanceRefusalResponse(issuance, requestId);
      const invalid = await updateProblems(
        deps.membershipAccess,
        principal.id,
        body,
        nowMs,
        issuance.cleanup,
      );
      if (invalid) return renderError(invalid, { requestId });

      const updated = await tokens.updateAuthorized(
        current,
        updatePatch(body, nowMs),
        issuance.approval,
      );
      if (!updated) throw new PersonalAccessTokenClaimRefused();
      if ("expiresAt" in body) {
        await writePersonalAccessTokenCache(store, updated, updated.tokenHash, false, nowMs);
      }
      return Response.json(personalAccessTokenResponse(updated, nowMs));
    },

    async rotate({ input, principal, requestId }: HandlerArgs<unknown>): Promise<Response> {
      const refused = personalAccessTokenManagementRefusal(principal);
      if (refused) return renderError(refused, { requestId });
      const store = requireStore(deps.store);
      const tokenId = pathParam(input, "tokenId");
      const current = await tokens.getForUser(principal.id, tokenId);
      if (!isActivePersonalAccessToken(current)) return notFound(requestId);
      const nowMs = now();
      const issuance = await authorizeIssuance(deps, principal, "rotate", {}, current);
      if ("refusal" in issuance) return issuanceRefusalResponse(issuance, requestId);
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
      const rotated = await rotatePersonalAccessToken(
        tokens,
        store,
        current,
        tokenHash,
        nowMs,
        issuance.approval,
      );
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

function newSecret(): string {
  return `${PERSONAL_ACCESS_TOKEN_SECRET_PREFIX}${randomHex(32)}`;
}

/** Mount the six routes. Callers mount this on the public bearer door only. */
export function mountPersonalAccessTokenRoutes(
  app: Hono,
  registrar: Registrar,
  deps: { repo: Repository; store?: KVNamespace; nowIso?: () => string },
): void {
  app.use("/personal-access-tokens*", async (c, next) => {
    c.header("access-control-allow-origin", "*");
    if (c.req.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET, POST, PATCH, OPTIONS",
          "access-control-allow-headers": "authorization, content-type, splitch-pat-authorization",
        },
      });
    }
    await next();
    return undefined;
  });
  const handlers = makePersonalAccessTokenHandlers({
    repo: deps.repo,
    membershipAccess: makeTokenMembershipAccess(deps.repo),
    ...(deps.store ? { store: deps.store } : {}),
    ...(deps.nowIso ? { nowMs: () => Date.parse(deps.nowIso?.() as string) } : {}),
  });
  for (const operation of ["create", "update", "rotate"] as const) {
    const handler = handlers[operation];
    handlers[operation] = async (args) => {
      try {
        return await handler(args);
      } catch (error) {
        if (!(error instanceof PersonalAccessTokenClaimRefused)) throw error;
        return renderError(
          forbidden(
            "PAT approval was already used or the token changed; rerun the same splitch tokens command to approve in the browser",
          ),
          { requestId: args.requestId },
        );
      }
    };
  }
  registrar.mount(app, controlPlaneRoute("personal_access_tokens_list"), handlers.list);
  registrar.mount(app, controlPlaneRoute("personal_access_tokens_create"), handlers.create);
  registrar.mount(app, controlPlaneRoute("personal_access_tokens_revoke_all"), handlers.revokeAll);
  registrar.mount(app, controlPlaneRoute("personal_access_tokens_update"), handlers.update);
  registrar.mount(app, controlPlaneRoute("personal_access_tokens_rotate"), handlers.rotate);
  registrar.mount(app, controlPlaneRoute("personal_access_tokens_revoke"), handlers.revoke);
}
