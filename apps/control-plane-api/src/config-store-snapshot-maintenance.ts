import { type DeltaNudge, DeltaNudgeSchema } from "@splitch/contracts";
import { appScope, envScope } from "@splitch/db";
import { deleteFlagConfigSnapshot, writeSnapshot } from "./config-store-kv";
import {
  buildSnapshotFromD1,
  type ConfigStoreRuntimeDeps,
  type FlagConfigResult,
  responseFromSnapshot,
} from "./config-store-shared";

export interface FlagConfigResyncInput {
  appId: string;
  environmentId: string;
  flagId: string;
}

export interface FlagConfigDeleteInput extends FlagConfigResyncInput {
  experimentIds: readonly string[];
  flagKey?: string;
}

export type FlagConfigDeleteResult =
  | { ok: true; nudge: DeltaNudge; snapshotRevision: number }
  | { ok: false; reason: "FLAG_NOT_FOUND" };

export async function repairFlagConfigSnapshot(
  deps: ConfigStoreRuntimeDeps,
  input: FlagConfigResyncInput,
): Promise<
  | { ok: true; config: FlagConfigResult; snapshotRevision: number }
  | { ok: false; reason: "FLAG_NOT_FOUND" }
> {
  const scope = envScope(input.appId, input.environmentId);
  return deps.snapshotMutations.run(async () => {
    const snapshot = await buildSnapshotFromD1(deps.repo, scope, input.flagId);
    if (!snapshot) return { ok: false, reason: "FLAG_NOT_FOUND" };
    const config = responseFromSnapshot(snapshot);
    const snapshotRevision = await deps.nextSnapshotRevision({
      flagId: input.flagId,
      operation: "repair",
    });
    await writeSnapshot(deps.kv, scope, snapshot, config, snapshotRevision);
    return { ok: true, config, snapshotRevision };
  });
}

export async function deleteFlagConfigFromStore(
  deps: ConfigStoreRuntimeDeps,
  input: FlagConfigDeleteInput,
): Promise<FlagConfigDeleteResult> {
  const scope = envScope(input.appId, input.environmentId);
  const flag =
    (input.flagKey
      ? { key: input.flagKey }
      : await deps.repo.flags.getFlag(appScope(input.appId), input.flagId)) ?? null;
  if (!flag) return { ok: false, reason: "FLAG_NOT_FOUND" };

  return deps.snapshotMutations.run(async () => {
    const existing = await buildSnapshotFromD1(deps.repo, scope, input.flagId);
    if (existing) {
      throw new Error(
        `config-store: refusing to delete a snapshot while Flag Configuration ${input.flagId} exists in D1`,
      );
    }
    const snapshotRevision = await deps.nextSnapshotRevision({
      flagId: input.flagId,
      operation: "delete",
    });
    const replacement = await deps.repo.flags.getFlagByKey(appScope(input.appId), flag.key);
    const replacementConfig =
      replacement && replacement.id !== input.flagId
        ? await deps.repo.flags.getFlagConfig(scope, replacement.id)
        : null;
    await deleteFlagConfigSnapshot(
      deps.kv,
      scope,
      input.flagId,
      snapshotRevision,
      flag.key,
      input.experimentIds,
      replacementConfig === null,
    );

    const nudge = DeltaNudgeSchema.parse({
      type: "config.changed",
      entity: "flag",
      id: input.flagId,
      version: 0,
      deleted: true,
    });
    await deps.broadcaster.broadcast(nudge);
    return { ok: true, nudge, snapshotRevision };
  });
}
