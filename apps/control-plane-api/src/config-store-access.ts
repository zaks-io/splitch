import {
  controlPlaneFlagConfigKey,
  type ExperimentConfigKV,
  type FlagConfigKV,
  type RunConfigKV,
} from "@splitch/contracts";
import { envScope, type Repository } from "@splitch/db";
import type { ConfigStoreWriter } from "./config-store";
import {
  assertControlPlaneFlagConfigSnapshotScope,
  type ControlPlaneFlagConfigSnapshot,
  ControlPlaneFlagConfigSnapshotScopeError,
  InvalidControlPlaneFlagConfigSnapshotError,
  readControlPlaneFlagConfigSnapshot,
} from "./config-store-kv";
import { readFlagConfigOnMiss } from "./config-store-read-miss";
import type { FlagConfigResult } from "./config-store-types";
import {
  type ConfigStoreWriteThrough,
  configStoreWriteThrough,
} from "./config-store-write-through";

export interface ConfigStoreDurableObjectNamespace {
  getByName(name: string): ConfigStoreDurableObjectStub;
}

interface ConfigStoreDurableObjectStub extends ConfigStoreWriter {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  readFlagConfigForEvaluation(
    input: EvaluationFlagConfigRead,
  ): Promise<EvaluationFlagConfigSnapshot | null>;
  setLiveUpdatesAvailable(available: boolean): Promise<void>;
}

export interface EvaluationFlagConfigRead {
  appId: string;
  environmentId: string;
  flagKey: string;
}

export interface EvaluationFlagConfigSnapshot {
  experiment: ExperimentConfigKV | null;
  flag: FlagConfigKV;
  run: RunConfigKV | null;
  version: number;
}

interface ConfigStoreLiveUpdates {
  connect(request: Request): Promise<Response>;
}

type FlagConfigRead = Pick<ConfigStoreWriter, "readFlagConfig">;

export interface ConfigStoreAccess extends FlagConfigRead {
  writerFor(appId: string, environmentId: string): ConfigStoreWriter;
  liveUpdatesFor(appId: string, environmentId: string): ConfigStoreLiveUpdates;
}

export interface ConfigStoreAccessOptions {
  logger?: Pick<Console, "error" | "warn">;
  now?: () => number;
  repo?: Repository;
  waitUntil?: (promise: Promise<unknown>) => void;
  writeThrough?: Map<string, ControlPlaneFlagConfigSnapshot>;
  writeThroughMaxEntries?: number;
  writeThroughTtlMs?: number;
}

const isolateWriteThrough = new Map<string, ControlPlaneFlagConfigSnapshot>();

function configWriterName(appId: string, environmentId: string): string {
  return `${appId}:${environmentId}`;
}

export function durableConfigStoreAccess(
  namespace: ConfigStoreDurableObjectNamespace,
  kv: KVNamespace,
  options: ConfigStoreAccessOptions = {},
): ConfigStoreAccess {
  const logger = options.logger ?? console;
  const writeThrough = options.writeThrough ?? isolateWriteThrough;
  const localSnapshots = configStoreWriteThrough(writeThrough, {
    maxEntries: options.writeThroughMaxEntries,
    now: options.now ?? Date.now,
    ttlMs: options.writeThroughTtlMs,
  });

  return {
    async readFlagConfig(input) {
      return readFlagConfigFromKv(
        namespace,
        kv,
        options.repo,
        options.waitUntil,
        logger,
        localSnapshots,
        input,
      );
    },

    writerFor(appId, environmentId) {
      const writer = namespace.getByName(configWriterName(appId, environmentId));
      const remember = <T>(result: T, flagId?: string): T =>
        rememberSnapshot(localSnapshots, appId, environmentId, result, flagId);

      return {
        readFlagConfig: (input) => writer.readFlagConfig(input),
        readFlagConfigPurgeTarget: (input) => writer.readFlagConfigPurgeTarget(input),
        repairFlagConfigSnapshot: (input) =>
          writer.repairFlagConfigSnapshot(input).then((result) => remember(result, input.flagId)),
        writeFlagConfig: (input) =>
          writer.writeFlagConfig(input).then((result) => remember(result, input.flagId)),
        replaceTargetingRules: (input) =>
          writer.replaceTargetingRules(input).then((result) => remember(result, input.flagId)),
        promoteFlagConfig: (input) =>
          writer.promoteFlagConfig(input).then((result) => remember(result, input.flagId)),
        previewFlagConfig: (input) => writer.previewFlagConfig(input),
        previewTargetingRules: (input) => writer.previewTargetingRules(input),
        previewPromotion: (input) => writer.previewPromotion(input),
        applyApprovedFlagConfig: (input) =>
          writer.applyApprovedFlagConfig(input).then((result) => remember(result, input.flagId)),
        syncExperimentConfig: (input) => writer.syncExperimentConfig(input).then(remember),
        resyncFlagConfig: (input) =>
          writer.resyncFlagConfig(input).then((result) => remember(result, input.flagId)),
        async deleteFlagConfig(input) {
          const result = await writer.deleteFlagConfig(input);
          if (isSuccessful(result)) {
            localSnapshots.set(controlPlaneFlagConfigKey(appId, environmentId, input.flagId), {
              appId,
              environmentId,
              flagId: input.flagId,
              revision: result.snapshotRevision,
              state: "deleted",
            });
          }
          return result;
        },
      };
    },

    liveUpdatesFor(appId, environmentId) {
      return {
        connect(request) {
          return namespace.getByName(configWriterName(appId, environmentId)).fetch(request);
        },
      };
    },
  };
}

async function readFlagConfigFromKv(
  namespace: ConfigStoreDurableObjectNamespace,
  kv: KVNamespace,
  repo: Repository | undefined,
  waitUntil: ((promise: Promise<unknown>) => void) | undefined,
  logger: Pick<Console, "error" | "warn">,
  localSnapshots: ConfigStoreWriteThrough,
  input: Parameters<ConfigStoreWriter["readFlagConfig"]>[0],
): ReturnType<ConfigStoreWriter["readFlagConfig"]> {
  const scope = envScope(input.appId, input.environmentId);
  const key = controlPlaneFlagConfigKey(input.appId, input.environmentId, input.flagId);
  const local = localSnapshots.get(key);
  let remote: ControlPlaneFlagConfigSnapshot | null;
  try {
    remote = await readControlPlaneFlagConfigSnapshot(kv, scope, input.flagId);
  } catch (cause) {
    reportSnapshotReadFailure(logger, key, input, cause);
    throw cause;
  }
  if (remote) {
    if (!local || remote.revision >= local.revision) {
      localSnapshots.delete(key);
      return flagConfigReadResult(remote);
    }
    assertControlPlaneFlagConfigSnapshotScope(local, scope, input.flagId);
    return flagConfigReadResult(local);
  }
  if (local) {
    assertControlPlaneFlagConfigSnapshotScope(local, scope, input.flagId);
    return flagConfigReadResult(local);
  }
  return readFlagConfigOnMiss({
    input,
    key,
    logger,
    namespace,
    repo,
    remember: (result) =>
      rememberSnapshot(localSnapshots, input.appId, input.environmentId, result, input.flagId),
    scope,
    waitUntil,
  });
}

function reportSnapshotReadFailure(
  logger: Pick<Console, "error">,
  key: string,
  input: Parameters<ConfigStoreWriter["readFlagConfig"]>[0],
  cause: unknown,
): void {
  let event = "config_store_kv_read_failed";
  if (cause instanceof InvalidControlPlaneFlagConfigSnapshotError) {
    event = "config_store_kv_schema_mismatch";
  } else if (cause instanceof ControlPlaneFlagConfigSnapshotScopeError) {
    event = "config_store_kv_snapshot_scope_mismatch";
  }
  logger.error(event, {
    key,
    ...input,
    ...(cause instanceof ControlPlaneFlagConfigSnapshotScopeError
      ? { mismatchAxes: cause.mismatchAxes }
      : {}),
    cause,
  });
}

function rememberSnapshot<T>(
  localSnapshots: ConfigStoreWriteThrough,
  appId: string,
  environmentId: string,
  result: T,
  expectedFlagId?: string,
): T {
  if (!hasConfig(result)) return result;
  const snapshotRevision = requireSnapshotRevision(result);
  if (snapshotRevision === null) return result;
  if (result.config.environmentId !== environmentId) {
    throw new Error("config-store: writer returned a Flag Configuration for another Environment");
  }
  if (expectedFlagId !== undefined && result.config.flagId !== expectedFlagId) {
    throw new Error("config-store: writer returned a Flag Configuration for another Flag");
  }
  const scope = envScope(appId, environmentId);
  const snapshot: ControlPlaneFlagConfigSnapshot = {
    appId,
    environmentId,
    flagId: result.config.flagId,
    revision: snapshotRevision,
    state: "present",
    config: result.config,
  };
  assertControlPlaneFlagConfigSnapshotScope(snapshot, scope, result.config.flagId);
  localSnapshots.set(
    controlPlaneFlagConfigKey(appId, environmentId, result.config.flagId),
    snapshot,
  );
  return result;
}

function hasConfig(value: unknown): value is { ok: true; config: FlagConfigResult } {
  return isSuccessful(value) && "config" in value;
}

function requireSnapshotRevision(value: object): number | null {
  if (!("snapshotRevision" in value)) {
    throw new Error("config-store: successful write omitted its snapshot revision");
  }
  if (value.snapshotRevision === null) {
    return value.snapshotRevision;
  }
  if (Number.isSafeInteger(value.snapshotRevision) && (value.snapshotRevision as number) >= 1) {
    return value.snapshotRevision as number;
  }
  throw new Error("config-store: successful write returned an invalid snapshot revision");
}

function isSuccessful(value: unknown): value is { ok: true } {
  return typeof value === "object" && value !== null && "ok" in value && value.ok === true;
}

function flagConfigReadResult(snapshot: ControlPlaneFlagConfigSnapshot) {
  return snapshot.state === "present"
    ? ({ ok: true, config: snapshot.config } as const)
    : ({ ok: false, reason: "FLAG_NOT_FOUND" } as const);
}
