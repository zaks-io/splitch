import type { APIKey, ClientKey } from "@splitch/contracts";
import { appScope, envScope, type Repository } from "@splitch/db";
import type { HandlerArgs } from "@splitch/worker-runtime";
import { renderError } from "@splitch/worker-runtime";
import { requireAppAdmin } from "./app-authz.js";
import { randomHex, sha256Hex, writeApiKeyCache, writeClientKeyCache } from "./credential-cache.js";
import { objectBody, pathParam } from "./handler-input.js";

interface CredentialHandlerDeps {
  repo: Repository;
  credentialStore?: KVNamespace;
  nowIso?: () => string;
}

type ApiKeyRow = Awaited<ReturnType<Repository["credentials"]["listApiKeys"]>>[number];
type ClientKeyRow = Awaited<ReturnType<Repository["credentials"]["listClientKeys"]>>[number];

export function makeCredentialHandlers(deps: CredentialHandlerDeps) {
  return {
    async getClientKey({ input, principal, requestId }: HandlerArgs<unknown>): Promise<Response> {
      const adminError = requireCredentialAdmin(input, principal.scopes, requestId);
      if (adminError) return adminError;
      const ctx = await credentialContext(deps, input, requestId);
      if (ctx instanceof Response) return ctx;

      const key = await ensureActiveClientKey(deps, ctx);
      await writeClientKeyCache(deps, key, false);
      return Response.json(clientKeyResponse(key));
    },

    async updateClientKey({
      input,
      principal,
      requestId,
    }: HandlerArgs<unknown>): Promise<Response> {
      const adminError = requireCredentialAdmin(input, principal.scopes, requestId);
      if (adminError) return adminError;
      const ctx = await credentialContext(deps, input, requestId);
      if (ctx instanceof Response) return ctx;

      const current = await ensureActiveClientKey(deps, ctx);
      const updates = clientKeyPatchValues(objectBody(input));
      const updated =
        (await deps.repo.credentials.updateClientKey(ctx.scope, current.keyId, updates)) ?? current;
      await writeClientKeyCache(deps, updated, false);
      return Response.json(clientKeyResponse(updated));
    },

    async rotateClientKey({
      input,
      principal,
      requestId,
    }: HandlerArgs<unknown>): Promise<Response> {
      const adminError = requireCredentialAdmin(input, principal.scopes, requestId);
      if (adminError) return adminError;
      const ctx = await credentialContext(deps, input, requestId);
      if (ctx instanceof Response) return ctx;

      const current = await ensureActiveClientKey(deps, ctx);
      const revokedAt = nowIso(deps);
      const revoked = (await deps.repo.credentials.updateClientKey(ctx.scope, current.keyId, {
        revokedAt,
      })) ?? {
        ...current,
        revokedAt,
      };
      await writeClientKeyCache(deps, revoked, true, true);

      const next = await createClientKey(deps, ctx);
      await writeClientKeyCache(deps, next, false);
      return Response.json({
        newKey: { keyId: next.keyId, keyMaterial: next.keyMaterial },
        revokedKeyId: revoked.keyId,
      });
    },

    async listApiKeys({ input, principal, requestId }: HandlerArgs<unknown>): Promise<Response> {
      const adminError = requireCredentialAdmin(input, principal.scopes, requestId);
      if (adminError) return adminError;
      const ctx = await credentialContext(deps, input, requestId);
      if (ctx instanceof Response) return ctx;

      const rows = await deps.repo.credentials.listApiKeys(ctx.scope);
      return Response.json({ items: rows.map(apiKeyResponse) });
    },

    async createApiKey({ input, principal, requestId }: HandlerArgs<unknown>): Promise<Response> {
      const adminError = requireCredentialAdmin(input, principal.scopes, requestId);
      if (adminError) return adminError;
      const ctx = await credentialContext(deps, input, requestId);
      if (ctx instanceof Response) return ctx;

      const body = objectBody(input);
      const scopes = body.scopes as string[];
      const secret = `sk_${randomHex(32)}`;
      const keyHash = await sha256Hex(secret);
      const row = await deps.repo.credentials.apiKeys.insert(ctx.scope, {
        keyId: `ak_${randomHex(16)}`,
        appId: ctx.appId,
        environmentId: ctx.environmentId,
        keyHash,
        scopes: JSON.stringify(scopes),
        createdAt: nowIso(deps),
        createdBy: principal.id,
      });
      await writeApiKeyCache(deps, row, false);
      return Response.json({ credential: apiKeyResponse(row), value: secret });
    },

    async revokeApiKey({ input, principal, requestId }: HandlerArgs<unknown>): Promise<Response> {
      const adminError = requireCredentialAdmin(input, principal.scopes, requestId);
      if (adminError) return adminError;
      const ctx = await credentialContext(deps, input, requestId);
      if (ctx instanceof Response) return ctx;

      const keyId = pathParam(input, "keyId");
      const current = await deps.repo.credentials.getApiKey(ctx.scope, keyId);
      if (!current) return credentialNotFound(requestId);

      const revoked =
        current.revokedAt == null ? await revokeActiveApiKey(deps, ctx, current) : current;
      await writeApiKeyCache(deps, revoked, true, true);
      return Response.json({ keyId: revoked.keyId, revokedAt: revoked.revokedAt });
    },
  };
}

function requireCredentialAdmin(
  input: unknown,
  heldScopes: readonly string[],
  requestId: string,
): Response | null {
  return requireAppAdmin(pathParam(input, "appId"), heldScopes, requestId);
}

async function credentialContext(
  deps: CredentialHandlerDeps,
  input: unknown,
  requestId: string,
): Promise<
  | {
      appId: string;
      environmentId: string;
      scope: ReturnType<typeof envScope>;
    }
  | Response
> {
  if (!deps.credentialStore) return credentialStoreUnavailable(requestId);

  const appId = pathParam(input, "appId");
  const environmentId = pathParam(input, "environmentId");
  const environment = await deps.repo.identity.getEnvironment(appScope(appId), environmentId);
  if (!environment) {
    return renderError(
      { code: "APP_NOT_FOUND", message: "app environment not found", details: {} },
      { requestId },
    );
  }
  return { appId, environmentId, scope: envScope(appId, environmentId) };
}

async function ensureActiveClientKey(
  deps: CredentialHandlerDeps,
  ctx: { appId: string; environmentId: string; scope: ReturnType<typeof envScope> },
): Promise<ClientKeyRow> {
  const active = await findActiveClientKey(deps, ctx);
  if (active) return active;

  try {
    return await createClientKey(deps, ctx);
  } catch (error) {
    const winner = await findActiveClientKey(deps, ctx);
    if (winner) return winner;
    throw error;
  }
}

async function findActiveClientKey(
  deps: CredentialHandlerDeps,
  ctx: { scope: ReturnType<typeof envScope> },
): Promise<ClientKeyRow | null> {
  const active = (await deps.repo.credentials.listClientKeys(ctx.scope)).filter(
    (k) => !k.revokedAt,
  );
  if (active.length > 1) {
    throw new Error("credential invariant failed: multiple active Client Keys in one Environment");
  }
  return active[0] ?? null;
}

async function createClientKey(
  deps: CredentialHandlerDeps,
  ctx: { appId: string; environmentId: string; scope: ReturnType<typeof envScope> },
): Promise<ClientKeyRow> {
  return deps.repo.credentials.clientKeys.insert(ctx.scope, {
    keyId: `ck_${randomHex(16)}`,
    appId: ctx.appId,
    environmentId: ctx.environmentId,
    keyMaterial: `pk_${randomHex(32)}`,
    originAllowlist: null,
    rateLimitRps: null,
    createdAt: nowIso(deps),
  });
}

async function revokeActiveApiKey(
  deps: CredentialHandlerDeps,
  ctx: { scope: ReturnType<typeof envScope> },
  current: ApiKeyRow,
): Promise<ApiKeyRow> {
  const revokedAt = nowIso(deps);
  return (
    (await deps.repo.credentials.revokeApiKey(ctx.scope, current.keyId, revokedAt)) ?? {
      ...current,
      revokedAt,
      lastRotatedAt: revokedAt,
    }
  );
}

function clientKeyResponse(row: ClientKeyRow): ClientKey {
  const originAllowlist = parseOriginAllowlist(row.originAllowlist);
  return {
    keyId: row.keyId,
    appId: row.appId,
    environmentId: row.environmentId,
    keyMaterial: row.keyMaterial,
    originAllowlist,
    isOriginOpen: originAllowlist === null,
    rateLimitRps: row.rateLimitRps,
    revokedAt: row.revokedAt,
    createdAt: row.createdAt,
  };
}

function apiKeyResponse(row: ApiKeyRow): APIKey {
  return {
    keyId: row.keyId,
    appId: row.appId,
    environmentId: row.environmentId,
    scopes: JSON.parse(row.scopes) as string[],
    revokedAt: row.revokedAt,
    createdAt: row.createdAt,
  };
}

function clientKeyPatchValues(body: Record<string, unknown>): Partial<ClientKeyRow> {
  const updates: Partial<ClientKeyRow> = {};
  if ("originAllowlist" in body) {
    updates.originAllowlist =
      body.originAllowlist === null ? null : JSON.stringify(body.originAllowlist);
  }
  if ("rateLimitRps" in body) {
    updates.rateLimitRps = body.rateLimitRps as number;
  }
  return updates;
}

function parseOriginAllowlist(value: string | null): string[] | null {
  return value === null ? null : (JSON.parse(value) as string[]);
}

function nowIso(deps?: CredentialHandlerDeps): string {
  return deps?.nowIso?.() ?? new Date().toISOString();
}

function credentialNotFound(requestId: string): Response {
  return renderError(
    { code: "CREDENTIAL_NOT_FOUND", message: "credential not found", details: {} },
    { requestId },
  );
}

function credentialStoreUnavailable(requestId: string): Response {
  return renderError(
    {
      code: "SERVICE_UNAVAILABLE",
      message: "credential store is not configured",
      details: { retryAfterMs: 1000 },
    },
    { requestId },
  );
}
