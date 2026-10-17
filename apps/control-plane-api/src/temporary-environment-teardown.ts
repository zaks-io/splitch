import { appScope } from "@splitch/db";
import { deleteEnvironmentCredentials } from "./app-environment-credentials";
import type { AppEnvironmentDeps } from "./app-environment-model";
import type { EnvironmentExposureStatusCleanupInput } from "./environment-exposure-status-cleanup";

type TeardownDeps = Pick<
  AppEnvironmentDeps,
  | "repo"
  | "configStore"
  | "credentialStore"
  | "credentialCacheWriter"
  | "exposureStatusCleanup"
  | "nowIso"
>;

export interface TemporaryEnvironmentTeardownInput extends EnvironmentExposureStatusCleanupInput {
  environmentId: string;
}

/** The Environment row survives every failed external step and is deleted last. */
export async function teardownTemporaryEnvironment(
  deps: TeardownDeps,
  input: TemporaryEnvironmentTeardownInput,
): Promise<void> {
  if (!deps.configStore) throw new Error("Temporary Environment teardown requires Config Store");
  if (!deps.exposureStatusCleanup)
    throw new Error("Temporary Environment teardown requires Exposure status cleanup");
  const scope = appScope(input.appId);
  const row = await deps.repo.identity.getEnvironment(scope, input.environmentId);
  if (row) {
    if (row.expiresAt === null)
      throw new Error("Temporary Environment teardown cannot delete a permanent Environment");
    const writer = deps.configStore.writerFor(input.appId, input.environmentId);
    const fenced = await writer.fenceTemporaryEnvironment({
      appId: input.appId,
      environmentId: input.environmentId,
      now: deps.nowIso?.() ?? new Date().toISOString(),
    });
    if (fenced.ok) {
      await deleteEnvironmentCredentials(deps, input.appId, input.environmentId);
      await writer.teardownTemporaryEnvironment(input);
    }
  }
  await deps.exposureStatusCleanup.delete(input);
  await deps.repo.identity.deleteTemporaryEnvironmentData(scope, input.environmentId);
}
