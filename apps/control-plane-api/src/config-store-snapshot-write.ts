import { type EnvScope, envScope } from "@splitch/db";
import { environmentWriteFailure } from "./config-store-expiry-fence";
import { catchConfigStoreFailure } from "./config-store-failure";
import { ensureInitialFlagConfig } from "./config-store-initial-config";
import { writeSnapshot } from "./config-store-kv";
import { flagConfigResult } from "./config-store-shared";
import { buildExperimentSnapshotFromD1, buildSnapshotFromD1 } from "./config-store-snapshot-build";
import type { FlagConfigResyncInput } from "./config-store-snapshot-maintenance";
import type { ConfigStoreRuntimeDeps, FlagConfigWriteResult, Snapshot } from "./config-store-types";

export interface ExperimentConfigSyncInput {
  appId: string;
  environmentId: string;
  experimentId: string;
}

export function resyncFlagConfig(
  deps: ConfigStoreRuntimeDeps,
  input: FlagConfigResyncInput,
): Promise<FlagConfigWriteResult> {
  return catchConfigStoreFailure(deps, async () => {
    if (input.initialConfig) await ensureInitialFlagConfig(deps, input, input.initialConfig);
    return writeFlagConfigSnapshot(deps, envScope(input.appId, input.environmentId), input.flagId);
  });
}

export function syncExperimentConfig(
  deps: ConfigStoreRuntimeDeps,
  input: ExperimentConfigSyncInput,
): Promise<FlagConfigWriteResult> {
  return catchConfigStoreFailure(deps, () =>
    writeExperimentConfigSnapshot(
      deps,
      envScope(input.appId, input.environmentId),
      input.experimentId,
    ),
  );
}

export function writeFlagConfigSnapshot(
  deps: ConfigStoreRuntimeDeps,
  scope: EnvScope,
  flagId: string,
): Promise<FlagConfigWriteResult> {
  return writeLoadedSnapshot(deps, scope, () => buildSnapshotFromD1(deps.repo, scope, flagId));
}

function writeExperimentConfigSnapshot(
  deps: ConfigStoreRuntimeDeps,
  scope: EnvScope,
  experimentId: string,
): Promise<FlagConfigWriteResult> {
  return writeLoadedSnapshot(deps, scope, () =>
    buildExperimentSnapshotFromD1(deps.repo, scope, experimentId),
  );
}

async function writeLoadedSnapshot(
  deps: ConfigStoreRuntimeDeps,
  scope: EnvScope,
  loadSnapshot: () => Promise<Snapshot | null>,
): Promise<FlagConfigWriteResult> {
  const refused = await environmentWriteFailure(deps, scope);
  if (refused) return refused;
  const snapshot = await loadSnapshot();
  if (!snapshot) return { ok: false, reason: "FLAG_NOT_FOUND" };

  const flagId = snapshot.flag.id;
  const result = flagConfigResult(flagId, snapshot);
  const snapshotRevision = await deps.nextSnapshotRevision({ flagId, operation: "write" });
  const expired = await environmentWriteFailure(deps, scope);
  if (expired) return expired;
  await writeSnapshot(deps.kv, scope, snapshot, result.config, snapshotRevision);
  await deps.broadcaster.broadcast(result.nudge);
  return { ...result, snapshotRevision };
}
