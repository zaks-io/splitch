import type { ClientKey } from "@splitch/contracts";
import type { envScope, Repository } from "@splitch/db";
import { randomHex, writeClientKeyCache } from "./credential-cache";

interface ClientKeyDeps {
  repo: Repository;
  credentialStore?: KVNamespace;
  nowIso?: () => string;
}

type EnvScopeValue = ReturnType<typeof envScope>;

export type ClientKeyRow = Awaited<ReturnType<Repository["credentials"]["listClientKeys"]>>[number];

export async function provisionClientKey(
  deps: ClientKeyDeps,
  ctx: { appId: string; environmentId: string; scope: EnvScopeValue },
): Promise<ClientKeyRow> {
  const key = await ensureActiveClientKey(deps, ctx);
  await writeClientKeyCache(deps, key, false);
  return key;
}

export async function ensureActiveClientKey(
  deps: ClientKeyDeps,
  ctx: { appId: string; environmentId: string; scope: EnvScopeValue },
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

export async function createClientKey(
  deps: ClientKeyDeps,
  ctx: { appId: string; environmentId: string; scope: EnvScopeValue },
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

export function clientKeyResponse(row: ClientKeyRow): ClientKey {
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

async function findActiveClientKey(
  deps: ClientKeyDeps,
  ctx: { scope: EnvScopeValue },
): Promise<ClientKeyRow | null> {
  const active = (await deps.repo.credentials.listClientKeys(ctx.scope)).filter(
    (k) => !k.revokedAt,
  );
  if (active.length > 1) {
    throw new Error("credential invariant failed: multiple active Client Keys in one Environment");
  }
  return active[0] ?? null;
}

function parseOriginAllowlist(value: string | null): string[] | null {
  return value === null ? null : (JSON.parse(value) as string[]);
}

function nowIso(deps?: ClientKeyDeps): string {
  return deps?.nowIso?.() ?? new Date().toISOString();
}
