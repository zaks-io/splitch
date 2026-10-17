import { appScope } from "@splitch/db";
import type { EnvironmentWriteScope } from "./config-store-expiry-fence";
import type { ConfigStoreRuntimeDeps } from "./config-store-types";

export interface TemporaryEnvironmentFenceInput extends EnvironmentWriteScope {
  now: string;
}

export async function fenceTemporaryEnvironment(
  deps: ConfigStoreRuntimeDeps,
  input: TemporaryEnvironmentFenceInput,
): Promise<{ ok: true } | { ok: false; reason: "ENVIRONMENT_NOT_FOUND" }> {
  const row = await deps.repo.identity.fenceTemporaryEnvironment(
    appScope(input.appId),
    input.environmentId,
    input.now,
  );
  if (!row) return { ok: false, reason: "ENVIRONMENT_NOT_FOUND" };
  if (row.expiresAt === null) throw new Error("config-store: cannot fence a permanent Environment");
  return { ok: true };
}

/** The journal survives Flag deletion and remains until every KV delete succeeds. */
export async function teardownTemporaryEnvironmentState(
  deps: ConfigStoreRuntimeDeps,
  input: EnvironmentWriteScope,
): Promise<void> {
  const row = await deps.repo.identity.getEnvironment(appScope(input.appId), input.environmentId);
  if (!row) return;
  const expiry = row.expiresAt === null ? Number.NaN : Date.parse(row.expiresAt);
  if (!Number.isFinite(expiry) || expiry > (deps.now?.() ?? new Date()).getTime()) {
    throw new Error("config-store: teardown requires an expired Temporary Environment");
  }
  if (!deps.clearEnvironmentState)
    throw new Error("config-store: Environment state removal is not configured");
  for (const key of await deps.projectionJournal.list()) await deps.kv.delete(key);
  await deps.clearEnvironmentState();
}
