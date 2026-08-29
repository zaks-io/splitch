import {
  CURRENT_KV_SCHEMA_VERSION,
  ExperimentConfigKVSchema,
  experimentConfigKey,
  type FlagConfigKV,
  FlagConfigKVSchema,
  flagConfigKey,
  kvEnvelope,
  LiveRunKVSchema,
  liveRunKey,
  RunConfigKVSchema,
  runConfigKey,
} from "@splitch/contracts";
import type { EnvScope } from "@splitch/db";
import type { FlagConfigResult, Snapshot } from "./config-store-shared";
import { controlPlaneRoute } from "./routes";

const FlagConfigEnvelope = kvEnvelope(FlagConfigKVSchema);
const ControlPlaneFlagConfigEnvelope = kvEnvelope(controlPlaneRoute("flag_config_get").output);
const ExperimentConfigEnvelope = kvEnvelope(ExperimentConfigKVSchema);
const RunConfigEnvelope = kvEnvelope(RunConfigKVSchema);
const LiveRunEnvelope = kvEnvelope(LiveRunKVSchema);

export function parseFlagConfigEnvelope(raw: string): FlagConfigKV {
  return FlagConfigEnvelope.parse(JSON.parse(raw)).data;
}

export function controlPlaneFlagConfigKey(scope: EnvScope, flagId: string): string {
  return `app:${scope.appId}:${scope.environmentId}:control-plane-flag-config:${flagId}`;
}

export type ControlPlaneFlagConfigSnapshot =
  | {
      appId: string;
      environmentId: string;
      flagId: string;
      revision: number;
      state: "present";
      config: FlagConfigResult;
    }
  | {
      appId: string;
      environmentId: string;
      flagId: string;
      revision: number;
      state: "deleted";
    };

export class InvalidControlPlaneFlagConfigSnapshotError extends Error {
  constructor(options: ErrorOptions) {
    super("control-plane Flag Configuration snapshot is malformed", options);
    this.name = "InvalidControlPlaneFlagConfigSnapshotError";
  }
}

export class ControlPlaneFlagConfigSnapshotScopeError extends Error {
  constructor(readonly mismatchAxes: readonly string[]) {
    super("control-plane Flag Configuration snapshot does not match its requested scope");
    this.name = "ControlPlaneFlagConfigSnapshotScopeError";
  }
}

export async function readControlPlaneFlagConfigSnapshot(
  kv: KVNamespace,
  scope: EnvScope,
  flagId: string,
): Promise<ControlPlaneFlagConfigSnapshot | null> {
  const raw = await kv.get(controlPlaneFlagConfigKey(scope, flagId), "text");
  if (raw === null) return null;
  const snapshot = parseControlPlaneFlagConfigSnapshot(raw);
  assertControlPlaneFlagConfigSnapshotScope(snapshot, scope, flagId);
  return snapshot;
}

export function assertControlPlaneFlagConfigSnapshotScope(
  snapshot: ControlPlaneFlagConfigSnapshot,
  scope: EnvScope,
  flagId: string,
): void {
  const mismatchAxes: string[] = [];
  if (snapshot.appId !== scope.appId) mismatchAxes.push("appId");
  if (snapshot.environmentId !== scope.environmentId) mismatchAxes.push("environmentId");
  if (snapshot.flagId !== flagId) mismatchAxes.push("flagId");
  if (snapshot.state === "present") {
    if (snapshot.config.environmentId !== scope.environmentId) {
      mismatchAxes.push("config.environmentId");
    }
    if (snapshot.config.flagId !== flagId) mismatchAxes.push("config.flagId");
  }
  if (mismatchAxes.length > 0) {
    throw new ControlPlaneFlagConfigSnapshotScopeError(mismatchAxes);
  }
}

export async function deleteFlagConfigSnapshot(
  kv: KVNamespace,
  scope: EnvScope,
  flagId: string,
  revision: number,
  flagKey: string,
  experimentId?: string | null,
): Promise<void> {
  await kv.put(
    controlPlaneFlagConfigKey(scope, flagId),
    serializeControlPlaneFlagConfigSnapshot({
      appId: scope.appId,
      environmentId: scope.environmentId,
      flagId,
      revision,
      state: "deleted",
    }),
  );
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
  controlPlaneConfig: FlagConfigResult,
  revision: number,
): Promise<void> {
  await kv.put(
    controlPlaneFlagConfigKey(scope, snapshot.flag.id),
    serializeControlPlaneFlagConfigSnapshot({
      appId: scope.appId,
      environmentId: scope.environmentId,
      flagId: snapshot.flag.id,
      revision,
      state: "present",
      config: controlPlaneConfig,
    }),
  );
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

function parseControlPlaneFlagConfigSnapshot(raw: string): ControlPlaneFlagConfigSnapshot {
  try {
    return parseControlPlaneFlagConfigSnapshotValue(JSON.parse(raw));
  } catch (cause) {
    if (cause instanceof InvalidControlPlaneFlagConfigSnapshotError) throw cause;
    throw new InvalidControlPlaneFlagConfigSnapshotError({ cause });
  }
}

function parseControlPlaneFlagConfigSnapshotValue(value: unknown): ControlPlaneFlagConfigSnapshot {
  if (!isRecord(value))
    throw new Error("control-plane Flag Configuration snapshot is not an object");
  if (value.schemaVersion !== CURRENT_KV_SCHEMA_VERSION) {
    throw new Error("control-plane Flag Configuration snapshot has an unknown schema version");
  }
  const scope = parseSnapshotScope(value);
  const revision = parseSnapshotRevision(value.revision);
  if (value.state === "deleted") {
    requireKeys(value, ["appId", "environmentId", "flagId", "revision", "schemaVersion", "state"]);
    return { ...scope, revision, state: "deleted" };
  }
  if (value.state === "present") {
    requireKeys(value, [
      "appId",
      "data",
      "environmentId",
      "flagId",
      "revision",
      "schemaVersion",
      "state",
    ]);
    return {
      ...scope,
      revision,
      state: "present",
      config: ControlPlaneFlagConfigEnvelope.shape.data.parse(value.data) as FlagConfigResult,
    };
  }
  throw new Error("control-plane Flag Configuration snapshot has an invalid state");
}

function parseSnapshotScope(value: Record<string, unknown>) {
  if (typeof value.appId !== "string" || value.appId.length === 0) {
    throw new Error("control-plane Flag Configuration snapshot has an invalid App id");
  }
  if (typeof value.environmentId !== "string" || value.environmentId.length === 0) {
    throw new Error("control-plane Flag Configuration snapshot has an invalid Environment id");
  }
  if (typeof value.flagId !== "string" || value.flagId.length === 0) {
    throw new Error("control-plane Flag Configuration snapshot has an invalid Flag id");
  }
  return { appId: value.appId, environmentId: value.environmentId, flagId: value.flagId };
}

function parseSnapshotRevision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error("control-plane Flag Configuration snapshot has an invalid revision");
  }
  return value as number;
}

function serializeControlPlaneFlagConfigSnapshot(snapshot: ControlPlaneFlagConfigSnapshot): string {
  const base = {
    schemaVersion: CURRENT_KV_SCHEMA_VERSION,
    appId: snapshot.appId,
    environmentId: snapshot.environmentId,
    flagId: snapshot.flagId,
    revision: snapshot.revision,
    state: snapshot.state,
  };
  return JSON.stringify(snapshot.state === "present" ? { ...base, data: snapshot.config } : base);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireKeys(value: Record<string, unknown>, expected: string[]): void {
  const actual = Object.keys(value).sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error("control-plane Flag Configuration snapshot has unknown fields");
  }
}

function envelope<T>(schema: ReturnType<typeof kvEnvelope>, data: T): string {
  return JSON.stringify(schema.parse({ schemaVersion: CURRENT_KV_SCHEMA_VERSION, data }));
}
