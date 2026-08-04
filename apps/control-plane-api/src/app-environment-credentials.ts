import { envScope, type Repository } from "@splitch/db";
import {
  type CredentialCacheWriterAccess,
  writeApiKeyCache,
  writeClientKeyCache,
} from "./credential-cache";

const MAX_CREDENTIAL_DELETE_PASSES = 100;

interface CredentialDeleteDeps {
  repo: Pick<Repository, "credentials">;
  credentialStore?: KVNamespace;
  credentialCacheWriter?: CredentialCacheWriterAccess;
  nowIso?: () => string;
}

type ApiKeyRow = Awaited<ReturnType<Repository["credentials"]["listApiKeys"]>>[number];
type ClientKeyRow = Awaited<ReturnType<Repository["credentials"]["listClientKeys"]>>[number];

export async function deleteEnvironmentCredentials(
  deps: CredentialDeleteDeps,
  appId: string,
  environmentId: string,
): Promise<void> {
  const scope = envScope(appId, environmentId);
  // Tombstone and remove one snapshot at a time. A concurrent credential created
  // after the snapshot remains in D1 for the next pass instead of being bulk
  // deleted with an active KV cache entry that was never revoked.
  for (let pass = 0; pass < MAX_CREDENTIAL_DELETE_PASSES; pass += 1) {
    const [apiKeys, clientKeys] = await Promise.all([
      deps.repo.credentials.listApiKeys(scope),
      deps.repo.credentials.listClientKeys(scope),
    ]);
    if (apiKeys.length === 0 && clientKeys.length === 0) return;
    await writeRevokedTombstones(deps, scope, apiKeys, clientKeys);
    await Promise.all([
      ...apiKeys.map((row) => deps.repo.credentials.removeApiKey(scope, row.keyId)),
      ...clientKeys.map((row) => deps.repo.credentials.removeClientKey(scope, row.keyId)),
    ]);
  }
  throw new Error("credential delete did not quiesce");
}

/**
 * Write revoked KV tombstones for every credential in the Environment without
 * mutating D1. Used by App delete before the atomic cascade batch so a rolled-
 * back D1 transaction cannot leave memberships gone while hot validation still
 * serves live key material (SPL-298).
 */
export async function tombstoneEnvironmentCredentials(
  deps: CredentialDeleteDeps,
  appId: string,
  environmentId: string,
): Promise<void> {
  const scope = envScope(appId, environmentId);
  const [apiKeys, clientKeys] = await Promise.all([
    deps.repo.credentials.listApiKeys(scope),
    deps.repo.credentials.listClientKeys(scope),
  ]);
  for (const row of apiKeys) {
    await writeApiKeyCache(deps, row, true, null, true);
  }
  for (const row of clientKeys) {
    await writeClientKeyCache(deps, row, true, null, true);
  }
}

async function writeRevokedTombstones(
  deps: CredentialDeleteDeps,
  scope: ReturnType<typeof envScope>,
  apiKeys: readonly ApiKeyRow[],
  clientKeys: readonly ClientKeyRow[],
): Promise<void> {
  for (const row of apiKeys) {
    const revoked =
      row.revokedAt === null
        ? await deps.repo.credentials.revokeApiKey(scope, row.keyId, nowIso(deps))
        : row;
    if (!revoked) throw new Error("credential revoke did not reach D1");
    await writeApiKeyCache(deps, revoked, true, null, true);
  }
  for (const row of clientKeys) {
    const revoked =
      row.revokedAt === null
        ? await deps.repo.credentials.updateClientKey(scope, row.keyId, { revokedAt: nowIso(deps) })
        : row;
    if (!revoked) throw new Error("credential revoke did not reach D1");
    await writeClientKeyCache(deps, revoked, true, null, true);
  }
}

function nowIso(deps: CredentialDeleteDeps): string {
  return deps.nowIso?.() ?? new Date().toISOString();
}
