import { type DeltaNudge, DeltaNudgeSchema } from "@splitch/contracts";
import { appScope, envScope } from "@splitch/db";
import { deleteFlagConfigSnapshot, writeSnapshot } from "./config-store-kv";
import {
  buildSnapshotFromD1,
  type ConfigStoreDeps,
  type FlagConfigResult,
  readFlagSnapshot,
  responseFromSnapshot,
} from "./config-store-shared";

export interface FlagConfigResyncInput {
  appId: string;
  environmentId: string;
  flagId: string;
}

export interface FlagConfigDeleteInput extends FlagConfigResyncInput {
  flagKey?: string;
}

export type FlagConfigDeleteResult =
  | { ok: true; nudge: DeltaNudge; snapshotRevision: number }
  | { ok: false; reason: "FLAG_NOT_FOUND" };

export async function repairFlagConfigSnapshot(
  deps: ConfigStoreDeps,
  input: FlagConfigResyncInput,
): Promise<
  | { ok: true; config: FlagConfigResult; snapshotRevision: number }
  | { ok: false; reason: "FLAG_NOT_FOUND" }
> {
  const scope = envScope(input.appId, input.environmentId);
  const snapshot = await buildSnapshotFromD1(deps.repo, scope, input.flagId);
  if (!snapshot) return { ok: false, reason: "FLAG_NOT_FOUND" };
  const config = responseFromSnapshot(snapshot);
  const snapshotRevision = await deps.nextSnapshotRevision({
    flagId: input.flagId,
    operation: "repair",
  });
  await writeSnapshot(deps.kv, scope, snapshot, config, snapshotRevision);
  return { ok: true, config, snapshotRevision };
}

export async function deleteFlagConfigFromStore(
  deps: ConfigStoreDeps,
  input: FlagConfigDeleteInput,
): Promise<FlagConfigDeleteResult> {
  const scope = envScope(input.appId, input.environmentId);
  const flag =
    (input.flagKey
      ? { key: input.flagKey }
      : await deps.repo.flags.getFlag(appScope(input.appId), input.flagId)) ?? null;
  if (!flag) return { ok: false, reason: "FLAG_NOT_FOUND" };

  const existing = await readFlagSnapshot(deps, scope, input.flagId);
  const experimentId = existing?.flag.experimentId ?? null;
  const snapshotRevision = await deps.nextSnapshotRevision({
    flagId: input.flagId,
    operation: "delete",
  });
  await deleteFlagConfigSnapshot(
    deps.kv,
    scope,
    input.flagId,
    snapshotRevision,
    flag.key,
    experimentId,
  );

  const nudge = DeltaNudgeSchema.parse({
    type: "config.changed",
    entity: "flag",
    id: input.flagId,
    version: 0,
  });
  await deps.broadcaster.broadcast(nudge);
  return { ok: true, nudge, snapshotRevision };
}
