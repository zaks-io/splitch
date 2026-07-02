import {
  apiKeyCacheKey,
  clientKeyCacheKey,
  type CredentialCacheKV,
  CURRENT_KV_SCHEMA_VERSION,
} from "@splitch/contracts";

const ACTIVE_CACHE_TTL_SECONDS = 60 * 60;
const REVOKED_TOMBSTONE_TTL_SECONDS = 5 * 60;

interface CredentialCacheDeps {
  credentialStore?: KVNamespace;
  nowIso?: () => string;
}

interface ClientKeyCacheRow {
  appId: string;
  environmentId: string;
  keyMaterial: string;
  originAllowlist: string | null;
  rateLimitRps: number | null;
}

interface ApiKeyCacheRow {
  appId: string;
  environmentId: string;
  keyHash: string;
  scopes: string;
}

export async function writeClientKeyCache(
  deps: CredentialCacheDeps,
  row: ClientKeyCacheRow,
  revoked: boolean,
  failLoud = false,
): Promise<void> {
  const key = clientKeyCacheKey(await sha256Hex(row.keyMaterial));
  await writeCredentialCache(deps, key, clientKeyCache(deps, row, revoked), failLoud);
}

export async function writeApiKeyCache(
  deps: CredentialCacheDeps,
  row: ApiKeyCacheRow,
  revoked: boolean,
  failLoud = false,
): Promise<void> {
  await writeCredentialCache(
    deps,
    apiKeyCacheKey(row.keyHash),
    apiKeyCache(deps, row, revoked),
    failLoud,
  );
}

export async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function randomHex(bytes: number): string {
  const out = new Uint8Array(bytes);
  crypto.getRandomValues(out);
  return [...out].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function writeCredentialCache(
  deps: CredentialCacheDeps,
  key: string,
  value: CredentialCacheKV,
  failLoud: boolean,
): Promise<void> {
  const ttl = value.revoked ? REVOKED_TOMBSTONE_TTL_SECONDS : ACTIVE_CACHE_TTL_SECONDS;
  try {
    const store = deps.credentialStore;
    if (!store) throw new Error("credential cache store is not configured");
    await store.put(key, JSON.stringify(envelope(value)), { expirationTtl: ttl });
  } catch (cause) {
    if (failLoud) throw cause;
  }
}

function clientKeyCache(
  deps: CredentialCacheDeps,
  row: ClientKeyCacheRow,
  revoked: boolean,
): CredentialCacheKV {
  const originAllowlist = parseOriginAllowlist(row.originAllowlist);
  return {
    appId: row.appId,
    environmentId: row.environmentId,
    kind: "client_key",
    scopes: ["data-plane:evaluate"],
    originAllowlist,
    rateLimitRps: row.rateLimitRps,
    revoked,
    cachedAt: nowIso(deps),
  };
}

function apiKeyCache(
  deps: CredentialCacheDeps,
  row: ApiKeyCacheRow,
  revoked: boolean,
): CredentialCacheKV {
  return {
    appId: row.appId,
    environmentId: row.environmentId,
    kind: "api_key",
    scopes: JSON.parse(row.scopes) as string[],
    revoked,
    cachedAt: nowIso(deps),
  };
}

function envelope(data: CredentialCacheKV) {
  return { schemaVersion: CURRENT_KV_SCHEMA_VERSION, data };
}

function parseOriginAllowlist(value: string | null): string[] | null {
  return value === null ? null : (JSON.parse(value) as string[]);
}

function nowIso(deps: CredentialCacheDeps): string {
  return deps.nowIso?.() ?? new Date().toISOString();
}
