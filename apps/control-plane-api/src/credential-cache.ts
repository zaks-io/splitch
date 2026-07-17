import {
  apiKeyCacheKey,
  type CredentialCacheKV,
  CURRENT_KV_SCHEMA_VERSION,
  clientKeyCacheKey,
} from "@splitch/contracts";

const REVOKED_TOMBSTONE_TTL_SECONDS = 5 * 60;

export interface CredentialCacheDeps {
  credentialStore?: KVNamespace;
  nowIso?: () => string;
}

export interface ClientKeyCacheRow {
  appId: string;
  environmentId: string;
  keyMaterial: string;
  originAllowlist: string | null;
  rateLimitRps: number | null;
}

export interface ApiKeyCacheRow {
  appId: string;
  environmentId: string;
  keyHash: string;
  scopes: string;
}

export async function writeClientKeyCache(
  deps: CredentialCacheDeps,
  row: ClientKeyCacheRow,
  revoked: boolean,
  organizationId: string | null = null,
  failLoud = false,
): Promise<void> {
  const key = clientKeyCacheKey(await sha256Hex(row.keyMaterial));
  await writeCredentialCache(
    deps,
    key,
    clientKeyCache(deps, row, revoked, organizationId),
    failLoud,
  );
}

export async function writeApiKeyCache(
  deps: CredentialCacheDeps,
  row: ApiKeyCacheRow,
  revoked: boolean,
  organizationId: string | null = null,
  failLoud = false,
): Promise<void> {
  await writeCredentialCache(
    deps,
    apiKeyCacheKey(row.keyHash),
    apiKeyCache(deps, row, revoked, organizationId),
    failLoud,
  );
}

export interface CredentialCacheBackfillRows {
  readonly clientKeys: readonly (ClientKeyCacheRow & {
    readonly organizationId: string;
    readonly revokedAt: string | null;
  })[];
  readonly apiKeys: readonly (ApiKeyCacheRow & {
    readonly organizationId: string;
    readonly revokedAt: string | null;
  })[];
}

/** Rewrites every D1 credential into the v2 cache shape using D1 App ownership. */
export async function backfillCredentialCaches(
  deps: CredentialCacheDeps,
  rows: CredentialCacheBackfillRows,
): Promise<number> {
  let written = 0;
  for (const row of rows.clientKeys) {
    await writeClientKeyCache(deps, row, row.revokedAt !== null, row.organizationId, true);
    written += 1;
  }
  for (const row of rows.apiKeys) {
    await writeApiKeyCache(deps, row, row.revokedAt !== null, row.organizationId, true);
    written += 1;
  }
  return written;
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
  if (!value.revoked && value.organizationId === null) {
    throw new Error("credential cache active writes require an organizationId");
  }
  // Active entries are written WITHOUT an expiry: the data plane has no D1
  // fallback on a KV miss (it rejects UNAUTHORIZED), so an expiring entry would
  // brick a deployed SDK key one TTL after the last control-plane touch.
  // Revocation correctness comes from the explicit tombstone below (written
  // fail-loud by rotate/revoke), never from active-entry expiry.
  const options = value.revoked ? { expirationTtl: REVOKED_TOMBSTONE_TTL_SECONDS } : undefined;
  try {
    const store = deps.credentialStore;
    if (!store) throw new Error("credential cache store is not configured");
    await store.put(key, JSON.stringify(envelope(value)), options);
  } catch (cause) {
    if (failLoud) throw cause;
  }
}

function clientKeyCache(
  deps: CredentialCacheDeps,
  row: ClientKeyCacheRow,
  revoked: boolean,
  organizationId: string | null,
): CredentialCacheKV {
  const originAllowlist = parseOriginAllowlist(row.originAllowlist);
  return {
    appId: row.appId,
    environmentId: row.environmentId,
    credentialSchemaVersion: 2,
    organizationId,
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
  organizationId: string | null,
): CredentialCacheKV {
  return {
    appId: row.appId,
    environmentId: row.environmentId,
    credentialSchemaVersion: 2,
    organizationId,
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
