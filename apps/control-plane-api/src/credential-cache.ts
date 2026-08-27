import {
  apiKeyCacheKey,
  type CredentialCacheKV,
  CredentialCacheKVSchema,
  CURRENT_KV_SCHEMA_VERSION,
  clientKeyCacheKey,
  credentialRevocationCacheKey,
  kvEnvelope,
  StoredClientKeyRateLimitRpsFieldSchema,
  TERMINAL_CREDENTIAL_REVOCATION_MARKER,
} from "@splitch/contracts";

const REVOKED_TOMBSTONE_TTL_SECONDS = 5 * 60;
const credentialEnvelope = kvEnvelope(CredentialCacheKVSchema);

export interface CredentialCacheDeps {
  credentialStore?: KVNamespace;
  credentialCacheWriter?: CredentialCacheWriterAccess;
  nowIso?: () => string;
}

export interface CredentialCacheWriter {
  put(write: CredentialCacheWrite): Promise<void>;
}

export interface CredentialCacheWrite {
  readonly key: string;
  readonly value: string;
  readonly options?: KVNamespacePutOptions;
  /** The D1 row the key-addressed writer must validate before replacing KV. */
  readonly credential: { readonly kind: "client_key" | "api_key"; readonly keyId: string };
}

export interface CredentialCacheWriterAccess {
  writerFor(key: string): CredentialCacheWriter;
}

export interface ClientKeyCacheRow {
  keyId: string;
  appId: string;
  environmentId: string;
  keyMaterial: string;
  originAllowlist: string | null;
  rateLimitRps: number | null;
}

export interface ApiKeyCacheRow {
  keyId: string;
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
    { kind: "client_key", keyId: row.keyId },
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
    { kind: "api_key", keyId: row.keyId },
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
  credential: CredentialCacheWrite["credential"],
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
  const write: CredentialCacheWrite = {
    key,
    value: JSON.stringify(envelope(value)),
    ...(options === undefined ? {} : { options }),
    credential,
  };
  try {
    const writer = deps.credentialCacheWriter?.writerFor(key);
    if (writer) {
      await writer.put(write);
      return;
    }
    if (!deps.credentialStore) throw new Error("credential cache store is not configured");
    await putCredentialCacheEntry(deps.credentialStore, write);
  } catch (cause) {
    if (failLoud) throw cause;
  }
}

export async function putCredentialCacheEntry(
  store: Pick<KVNamespace, "put">,
  write: CredentialCacheWrite,
): Promise<void> {
  const candidate = credentialEnvelope.parse(JSON.parse(write.value)).data;
  if (candidate.revoked) {
    await store.put(credentialRevocationCacheKey(write.key), TERMINAL_CREDENTIAL_REVOCATION_MARKER);
  }
  await store.put(write.key, write.value, write.options);
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
    scopes: ["data-plane:evaluate", "data-plane:write"],
    originAllowlist,
    rateLimitRps: StoredClientKeyRateLimitRpsFieldSchema.parse(row.rateLimitRps),
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
