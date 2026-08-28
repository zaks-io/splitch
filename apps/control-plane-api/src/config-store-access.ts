import type { ExperimentConfigKV, FlagConfigKV, RunConfigKV } from "@splitch/contracts";
import { envScope } from "@splitch/db";
import type { ConfigStoreWriter } from "./config-store";
import { controlPlaneFlagConfigKey, readControlPlaneFlagConfigSnapshot } from "./config-store-kv";
import type { FlagConfigResult } from "./config-store-types";

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
  logger?: Pick<Console, "warn">;
  writeThrough?: Map<string, FlagConfigResult>;
}

const isolateWriteThrough = new Map<string, FlagConfigResult>();

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

  return {
    async readFlagConfig(input) {
      const scope = envScope(input.appId, input.environmentId);
      const key = controlPlaneFlagConfigKey(scope, input.flagId);
      const local = writeThrough.get(key);

      try {
        const snapshot = await readControlPlaneFlagConfigSnapshot(kv, scope, input.flagId);
        if (snapshot) {
          if (!local || snapshot.version >= local.version) {
            writeThrough.delete(key);
            return { ok: true, config: snapshot };
          }
          return { ok: true, config: local };
        }
      } catch (cause) {
        logger.warn("config_store_kv_schema_mismatch", { key, cause });
        throw cause;
      }

      logger.warn("config_store_kv_snapshot_miss", {
        key,
        appId: input.appId,
        environmentId: input.environmentId,
        flagId: input.flagId,
      });
      return namespace
        .getByName(configWriterName(input.appId, input.environmentId))
        .readFlagConfig(input);
    },

    writerFor(appId, environmentId) {
      const writer = namespace.getByName(configWriterName(appId, environmentId));
      const remember = <T>(result: T): T => {
        if (!hasConfig(result)) return result;
        const scope = envScope(appId, result.config.environmentId);
        writeThrough.set(controlPlaneFlagConfigKey(scope, result.config.flagId), result.config);
        return result;
      };

      return {
        readFlagConfig: (input) => writer.readFlagConfig(input),
        writeFlagConfig: (input) => writer.writeFlagConfig(input).then(remember),
        replaceTargetingRules: (input) => writer.replaceTargetingRules(input).then(remember),
        promoteFlagConfig: (input) => writer.promoteFlagConfig(input).then(remember),
        previewFlagConfig: (input) => writer.previewFlagConfig(input),
        previewTargetingRules: (input) => writer.previewTargetingRules(input),
        previewPromotion: (input) => writer.previewPromotion(input),
        applyApprovedFlagConfig: (input) => writer.applyApprovedFlagConfig(input).then(remember),
        syncExperimentConfig: (input) => writer.syncExperimentConfig(input).then(remember),
        resyncFlagConfig: (input) => writer.resyncFlagConfig(input).then(remember),
        async deleteFlagConfig(input) {
          const result = await writer.deleteFlagConfig(input);
          if (isSuccessful(result)) {
            writeThrough.delete(
              controlPlaneFlagConfigKey(envScope(appId, environmentId), input.flagId),
            );
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

function hasConfig(value: unknown): value is { ok: true; config: FlagConfigResult } {
  return isSuccessful(value) && "config" in value;
}

function isSuccessful(value: unknown): value is { ok: true } {
  return typeof value === "object" && value !== null && "ok" in value && value.ok === true;
}
