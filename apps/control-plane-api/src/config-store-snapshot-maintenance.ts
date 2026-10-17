import { type DeltaNudge, DeltaNudgeSchema } from "@splitch/contracts";
import { appScope, envScope } from "@splitch/db";
import { type EnvironmentWriteFailure, environmentWriteFailure } from "./config-store-expiry-fence";
import { deleteFlagConfigSnapshot, writeSnapshot } from "./config-store-kv";
import {
  type ConfigStoreRuntimeDeps,
  type FlagConfigResult,
  responseFromSnapshot,
} from "./config-store-shared";
import { buildSnapshotFromD1 } from "./config-store-snapshot-build";

export interface FlagConfigResyncInput {
  appId: string;
  environmentId: string;
  flagId: string;
  initialConfig?: { defaultVariantId: string };
}

export interface FlagConfigDeleteInput extends FlagConfigResyncInput {
  experimentIds: readonly string[];
  flagKey?: string;
}

export type FlagConfigDeleteResult =
  | { ok: true; nudge: DeltaNudge; snapshotRevision: number | null }
  | { ok: false; reason: "FLAG_NOT_FOUND" };

export async function repairFlagConfigSnapshot(
  deps: ConfigStoreRuntimeDeps,
  input: FlagConfigResyncInput,
): Promise<
  | { ok: true; config: FlagConfigResult; snapshotRevision: number }
  | { ok: false; reason: "FLAG_NOT_FOUND" }
  | EnvironmentWriteFailure
> {
  const scope = envScope(input.appId, input.environmentId);
  const snapshot = await buildSnapshotFromD1(deps.repo, scope, input.flagId);
  if (!snapshot) return { ok: false, reason: "FLAG_NOT_FOUND" };
  const config = responseFromSnapshot(snapshot);
  const snapshotRevision = await deps.nextSnapshotRevision({
    flagId: input.flagId,
    operation: "repair",
  });
  const refused = await environmentWriteFailure(deps, scope);
  if (refused) return refused;
  await writeSnapshot(deps.kv, scope, snapshot, config, snapshotRevision);
  return { ok: true, config, snapshotRevision };
}

export async function deleteFlagConfigFromStore(
  deps: ConfigStoreRuntimeDeps,
  input: FlagConfigDeleteInput,
): Promise<FlagConfigDeleteResult> {
  const scope = envScope(input.appId, input.environmentId);
  const nudge = DeltaNudgeSchema.parse({
    type: "config.changed",
    entity: "flag",
    id: input.flagId,
    version: 0,
    deleted: true,
  });
  const flag =
    (input.flagKey
      ? { key: input.flagKey }
      : await deps.repo.flags.getFlag(appScope(input.appId), input.flagId)) ?? null;
  if (!flag) return { ok: false, reason: "FLAG_NOT_FOUND" };

  const existing = await buildSnapshotFromD1(deps.repo, scope, input.flagId);
  if (existing) {
    throw new Error(
      `config-store: refusing to delete a snapshot while Flag Configuration ${input.flagId} exists in D1`,
    );
  }
  const refused = await environmentWriteFailure(deps, scope);
  const snapshotRevision = refused
    ? null
    : await deps.nextSnapshotRevision({ flagId: input.flagId, operation: "delete" });
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

  await deps.broadcaster.broadcast(nudge);
  return { ok: true, nudge, snapshotRevision };
}
