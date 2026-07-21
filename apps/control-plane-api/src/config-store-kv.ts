import {
  CURRENT_KV_SCHEMA_VERSION,
  ExperimentConfigKVSchema,
  FlagConfigKVSchema,
  LiveRunKVSchema,
  RunConfigKVSchema,
  experimentConfigKey,
  flagConfigKey,
  kvEnvelope,
  liveRunKey,
  runConfigKey,
  type FlagConfigKV,
} from "@splitch/contracts";
import type { EnvScope } from "@splitch/db";
import type { Snapshot } from "./config-store-shared";

const FlagConfigEnvelope = kvEnvelope(FlagConfigKVSchema);
const ExperimentConfigEnvelope = kvEnvelope(ExperimentConfigKVSchema);
const RunConfigEnvelope = kvEnvelope(RunConfigKVSchema);
const LiveRunEnvelope = kvEnvelope(LiveRunKVSchema);

export function parseFlagConfigEnvelope(raw: string): FlagConfigKV {
  return FlagConfigEnvelope.parse(JSON.parse(raw)).data;
}

export async function deleteFlagConfigSnapshot(
  kv: KVNamespace,
  scope: EnvScope,
  flagKey: string,
  experimentId?: string | null,
): Promise<void> {
  await kv.delete(flagConfigKey(scope.appId, scope.environmentId, flagKey));
  if (experimentId) {
    await kv.delete(experimentConfigKey(scope.appId, scope.environmentId, experimentId));
    await kv.delete(liveRunKey(scope.appId, scope.environmentId, experimentId));
  }
}

export async function writeSnapshot(
  kv: KVNamespace,
  scope: EnvScope,
  snapshot: Snapshot,
): Promise<void> {
  await kv.put(
    flagConfigKey(scope.appId, scope.environmentId, snapshot.flag.key),
    envelope(FlagConfigEnvelope, snapshot.flag),
  );
  if (snapshot.experiment) {
    await kv.put(
      experimentConfigKey(scope.appId, scope.environmentId, snapshot.experiment.id),
      envelope(ExperimentConfigEnvelope, snapshot.experiment),
    );
  }
  if (snapshot.run) {
    await kv.put(
      runConfigKey(scope.appId, scope.environmentId, snapshot.run.id),
      envelope(RunConfigEnvelope, snapshot.run),
    );
    await kv.put(
      liveRunKey(scope.appId, scope.environmentId, snapshot.run.experimentId),
      envelope(LiveRunEnvelope, {
        runId: snapshot.run.id,
      }),
    );
  } else if (snapshot.experiment) {
    await kv.delete(liveRunKey(scope.appId, scope.environmentId, snapshot.experiment.id));
  }
}

function envelope<T>(schema: ReturnType<typeof kvEnvelope>, data: T): string {
  return JSON.stringify(schema.parse({ schemaVersion: CURRENT_KV_SCHEMA_VERSION, data }));
}
