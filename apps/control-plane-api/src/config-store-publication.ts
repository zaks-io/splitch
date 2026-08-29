import { type EnvScope, envScope } from "@splitch/db";
import { catchConfigStoreFailure } from "./config-store-failure";
import { writeSnapshot } from "./config-store-kv";
import {
  buildExperimentSnapshotFromD1,
  buildSnapshotFromD1,
  flagConfigResult,
} from "./config-store-shared";
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
  return catchConfigStoreFailure(deps, () =>
    publishFlagConfigSnapshot(deps, envScope(input.appId, input.environmentId), input.flagId),
  );
}

export function syncExperimentConfig(
  deps: ConfigStoreRuntimeDeps,
  input: ExperimentConfigSyncInput,
): Promise<FlagConfigWriteResult> {
  return catchConfigStoreFailure(deps, () =>
    publishExperimentConfigSnapshot(
      deps,
      envScope(input.appId, input.environmentId),
      input.experimentId,
    ),
  );
}

export function publishFlagConfigSnapshot(
  deps: ConfigStoreRuntimeDeps,
  scope: EnvScope,
  flagId: string,
): Promise<FlagConfigWriteResult> {
  return publishSnapshot(deps, scope, () => buildSnapshotFromD1(deps.repo, scope, flagId));
}

export function publishExperimentConfigSnapshot(
  deps: ConfigStoreRuntimeDeps,
  scope: EnvScope,
  experimentId: string,
): Promise<FlagConfigWriteResult> {
  return publishSnapshot(deps, scope, () =>
    buildExperimentSnapshotFromD1(deps.repo, scope, experimentId),
  );
}

async function publishSnapshot(
  deps: ConfigStoreRuntimeDeps,
  scope: EnvScope,
  loadSnapshot: () => Promise<Snapshot | null>,
): Promise<FlagConfigWriteResult> {
  return deps.snapshotMutations.run(async () => {
    const snapshot = await loadSnapshot();
    if (!snapshot) return { ok: false, reason: "FLAG_NOT_FOUND" };

    const flagId = snapshot.flag.id;
    const result = flagConfigResult(flagId, snapshot);
    const snapshotRevision = await deps.nextSnapshotRevision({ flagId, operation: "write" });
    await writeSnapshot(deps.kv, scope, snapshot, result.config, snapshotRevision);
    await deps.broadcaster.broadcast(result.nudge);
    return { ...result, snapshotRevision };
  });
}
