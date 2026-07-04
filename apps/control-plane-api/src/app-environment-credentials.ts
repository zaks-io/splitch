import { envScope, type Repository } from "@splitch/db";
import { writeApiKeyCache, writeClientKeyCache } from "./credential-cache";

interface CredentialDeleteDeps {
  repo: Pick<Repository, "credentials">;
  credentialStore?: KVNamespace;
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

  await writeRevokedTombstones(deps, apiKeys, clientKeys);
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
  apiKeys: readonly ApiKeyRow[],
  clientKeys: readonly ClientKeyRow[],
): Promise<void> {
  for (const row of apiKeys) {
    await writeApiKeyCache(deps, row, true, true);
  }
  for (const row of clientKeys) {
    await writeClientKeyCache(deps, row, true, true);
  }
}
