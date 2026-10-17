import type { CredentialCacheKV } from "@splitch/contracts";
import { appScope, type Repository } from "@splitch/db";
import { environmentHasExpired } from "./temporary-environment-errors";

export async function credentialEnvironmentExpiry(
  repo: Pick<Repository, "identity">,
  candidate: CredentialCacheKV,
  now: string,
): Promise<CredentialCacheKV> {
  const environment = await repo.identity.getEnvironment(
    appScope(candidate.appId),
    candidate.environmentId,
  );
  if (!environment && !candidate.revoked)
    throw new Error("credential cache write rejected: Environment no longer exists");
  if (environment && !candidate.revoked && environmentHasExpired(environment, now)) {
    throw new Error("credential cache write rejected: Temporary Environment has expired");
  }
  const { expiresAt: _, ...permanent } = candidate as CredentialCacheKV & {
    expiresAt?: string | null;
  };
  return !environment || environment.expiresAt === null
    ? { ...permanent, credentialSchemaVersion: 2 }
    : { ...permanent, credentialSchemaVersion: 3, expiresAt: environment.expiresAt };
}
