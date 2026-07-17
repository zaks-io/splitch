import { envScope, type Repository } from "@splitch/db";
import {
  type CredentialCacheWriterAccess,
  writeApiKeyCache,
  writeClientKeyCache,
} from "./credential-cache";

interface CredentialDeleteDeps {
  repo: Pick<Repository, "credentials">;
  credentialStore?: KVNamespace;
  credentialCacheWriter?: CredentialCacheWriterAccess;
  nowIso?: () => string;
}

type ApiKeyRow = Awaited<ReturnType<Repository["credentials"]["listApiKeys"]>>[number];
type ClientKeyRow = Awaited<ReturnType<Repository["credentials"]["listClientKeys"]>>[number];

export async function revokeEnvironmentCredentialCaches(
  deps: CredentialDeleteDeps,
  appId: string,
  environmentId: string,
): Promise<void> {
  const scope = envScope(appId, environmentId);
  const [apiKeys, clientKeys] = await Promise.all([
    deps.repo.credentials.listApiKeys(scope),
    deps.repo.credentials.listClientKeys(scope),
  ]);

  await writeRevokedTombstones(deps, scope, apiKeys, clientKeys);
}

export async function deleteEnvironmentCredentialRows(
  deps: CredentialDeleteDeps,
  appId: string,
  environmentId: string,
): Promise<void> {
  const scope = envScope(appId, environmentId);
  await deps.repo.credentials.apiKeys.remove(scope);
  await deps.repo.credentials.clientKeys.remove(scope);
}

export async function deleteEnvironmentCredentials(
  deps: CredentialDeleteDeps,
  appId: string,
  environmentId: string,
): Promise<void> {
  await revokeEnvironmentCredentialCaches(deps, appId, environmentId);
  await deleteEnvironmentCredentialRows(deps, appId, environmentId);
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
