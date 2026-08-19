import type { DeltaNudge, FlagConfigKV } from "@splitch/contracts";
import { experimentConfigKey, flagConfigKey, runConfigKey } from "@splitch/contracts";
import { FlagConfigCache } from "./cache";
import type {
  ConfigUpdateListener,
  DurableConfigUpdates,
  EvaluationConfigSnapshot,
} from "./config-updates";
import {
  type BlobParse,
  parseExperimentConfig,
  parseFlagConfig,
  parseRunConfig,
  readKvBlob,
} from "./kv-provider-blobs";
import { type ExperimentConfig, type FlagConfig, type Provider, ProviderError } from "./provider";
import { experimentConfigFromKV, flagConfigFromKV } from "./resolve";

/**
 * Read-side Provider adapter. With live updates, Flag Configuration comes from
 * the authoritative Config Store snapshot; KV is consulted only when that read
 * fails and the announced version must be classified. Without live updates it
 * reads app-scoped KV keys directly. It never writes.
 *
 * Fail-loud (ADR-0025/0036): EVERY read is Zod-parsed against the schema-version
 * envelope plus the inner schema. A KV miss, malformed JSON, unknown schema
 * version, or partial/invalid blob THROWS a ProviderError (errorCode
 * INTERNAL_SERVER_ERROR) — never a half-valid view into assign(). The
 * evaluate-path orchestration turns the throw into `reason: ERROR` + the code and
 * fires no Exposure.
 *
 * Tenant isolation: keys are built by the shared app-scoped key constructors, so
 * a getFlag for App A reads `app:A:...` and can never return App B config.
 */

/** The minimal KV read surface this adapter needs; a fake KV in tests satisfies it. */
export interface KvReader {
  get(key: string): Promise<string | null>;
  list(options: { prefix: string; cursor?: string }): Promise<{
    keys: { name: string }[];
    /** Real KVNamespace.list pages at 1000 keys; fakes may omit both fields. */
    list_complete?: boolean;
    cursor?: string;
  }>;
}

export interface PropagationBreach {
  announcedVersion: number;
  appId: string;
  elapsedMs: number;
  environmentId: string;
  servedVersion: number;
}

export interface KvProviderOptions {
  configUpdates?: Pick<DurableConfigUpdates, "ensureSubscribed" | "readCurrentFlagConfig">;
  now?: () => number;
  onPropagationBreach?: (breach: PropagationBreach) => void;
}

export class KvProvider implements Provider {
  private readonly cache = new FlagConfigCache();
  private readonly experimentSnapshots = new Map<
    string,
    Pick<EvaluationConfigSnapshot, "experiment" | "run">
  >();
  private readonly flagExperiments = new Map<string, string>();
  private readonly now: () => number;

  constructor(
    private readonly kv: KvReader,
    private readonly options: KvProviderOptions = {},
  ) {
    this.now = options.now ?? Date.now;
  }

  async getFlag(appId: string, environmentId: string, flagKey: string): Promise<FlagConfig> {
    await this.ensureSubscribed(appId, environmentId);
    const key = flagConfigKey(appId, environmentId, flagKey);

    const cached = this.cache.get(key);
    if (cached !== undefined) {
      return cached.config;
    }

    // ONE read: experimentId is denormalized on the flag blob, so flag ->
    // experiment never needs a second KV get here.
    const fresh = await this.readFreshFlagBlob(
      appId,
      environmentId,
      flagKey,
      key,
      `flag ${flagKey}`,
      "FLAG_NOT_FOUND",
    );
    const config = flagConfigFromKV(appId, fresh.flag);
    if (!this.cache.set(key, fresh.flag.id, fresh.version, config)) {
      throw this.staleReadError(appId, environmentId, fresh.flag.id, fresh.version);
    }
    return config;
  }

  async getFlags(appId: string, environmentId: string): Promise<FlagConfig[]> {
    await this.ensureSubscribed(appId, environmentId);
    const prefix = `app:${appId}:${environmentId}:flag:`;
    const keys = await this.listAllKeys(prefix);

    return Promise.all(
      keys.map(async ({ name }) => {
        const cached = this.cache.get(name);
        if (cached !== undefined) {
          return cached.config;
        }
        const flagKey = name.slice(prefix.length);
        const fresh = await this.readFreshFlagBlob(appId, environmentId, flagKey, name, name);
        const config = flagConfigFromKV(appId, fresh.flag);
        if (!this.cache.set(name, fresh.flag.id, fresh.version, config)) {
          throw this.staleReadError(appId, environmentId, fresh.flag.id, fresh.version);
        }
        return config;
      }),
    );
  }

  async getExperiment(
    appId: string,
    environmentId: string,
    experimentId: string,
  ): Promise<ExperimentConfig> {
    const key = experimentConfigKey(appId, environmentId, experimentId);
    const current = this.experimentSnapshots.get(key);
    if (current?.experiment !== null && current?.experiment !== undefined) {
      return experimentConfigFromKV(appId, current.experiment, current.run);
    }
    const experiment = await this.readBlob(
      key,
      parseExperimentConfig,
      `experiment ${experimentId}`,
    );

    const run =
      experiment.liveRunId === null
        ? null
        : await this.readBlob(
            runConfigKey(appId, environmentId, experiment.liveRunId),
            parseRunConfig,
            `run ${experiment.liveRunId}`,
          );

    return experimentConfigFromKV(appId, experiment, run);
  }

  invalidate(appId: string, environmentId: string, nudge: DeltaNudge): void {
    this.cache.invalidate(appId, environmentId, nudge, this.now());
  }

  /**
   * Drop every cached Flag / Experiment snapshot for one Environment.
   * Live-update reconnect uses this; local harnesses without a socket do too.
   */
  invalidateEnvironment(appId: string, environmentId: string): void {
    this.cache.invalidateEnvironment(appId, environmentId);
    const prefix = `app:${appId}:${environmentId}:experiment:`;
    for (const key of this.experimentSnapshots.keys()) {
      if (key.startsWith(prefix)) this.experimentSnapshots.delete(key);
    }
    const flagPrefix = `app:${appId}:${environmentId}:flag:`;
    for (const key of this.flagExperiments.keys()) {
      if (key.startsWith(flagPrefix)) this.flagExperiments.delete(key);
    }
  }

  private async ensureSubscribed(appId: string, environmentId: string): Promise<void> {
    const updates = this.options.configUpdates;
    if (updates === undefined) return;

    const listener: ConfigUpdateListener = {
      onNudge: (nudge) => this.invalidate(appId, environmentId, nudge),
      onReconnect: () => this.invalidateEnvironment(appId, environmentId),
    };
    try {
      await updates.ensureSubscribed(appId, environmentId, listener);
    } catch (cause) {
      throw new ProviderError("Flag Configuration live updates are unavailable", {
        cause,
        errorCode: "SERVICE_UNAVAILABLE",
      });
    }
  }

  /**
   * Drain every list page. KVNamespace.list returns at most 1000 keys per call;
   * ignoring the cursor would silently truncate a >1000-flag environment to an
   * arbitrary subset — fail loud instead if the cursor contract is violated.
   */
  private async listAllKeys(prefix: string): Promise<{ name: string }[]> {
    const keys: { name: string }[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.kv.list({ prefix, ...(cursor === undefined ? {} : { cursor }) });
      keys.push(...page.keys);
      if (page.list_complete === false && page.cursor === undefined) {
        throw new ProviderError(`KV list for prefix "${prefix}" is incomplete with no cursor`);
      }
      cursor = page.list_complete === false ? page.cursor : undefined;
    } while (cursor !== undefined);
    return keys;
  }

  /**
   * Read + parse one KV blob, fail-loud. A miss, malformed JSON, unknown schema
   * version, or schema violation throws a ProviderError — a partial/half-valid
   * object must never escape this boundary.
   */
  private async readBlob<T>(
    key: string,
    parse: BlobParse<T>,
    label: string,
    missCode: ProviderError["errorCode"] = "INTERNAL_SERVER_ERROR",
  ): Promise<T> {
    return readKvBlob(this.kv, key, parse, label, missCode);
  }

  private async readFreshFlagBlob(
    appId: string,
    environmentId: string,
    flagKey: string,
    key: string,
    label: string,
    missCode: ProviderError["errorCode"] = "INTERNAL_SERVER_ERROR",
  ): Promise<{ flag: FlagConfigKV; version: number }> {
    const updates = this.options.configUpdates;
    if (updates === undefined) {
      return { flag: await this.readBlob(key, parseFlagConfig, label, missCode), version: 0 };
    }

    let current: EvaluationConfigSnapshot | null;
    try {
      current = await updates.readCurrentFlagConfig(appId, environmentId, flagKey);
    } catch (cause) {
      throw await this.authoritativeReadError(appId, environmentId, key, label, missCode, cause);
    }
    if (current === null) {
      throw new ProviderError(`Flag Configuration ${appId}/${environmentId}/${flagKey} is gone`, {
        errorCode: "FLAG_NOT_FOUND",
      });
    }

    const announced = this.cache.announcedVersion(appId, environmentId, current.flag.id);
    const servedVersion = this.cache.servedVersion(appId, environmentId, current.flag.id) ?? 0;
    const minimumVersion = Math.max(servedVersion, announced?.version ?? 0);
    if (current.version < minimumVersion) {
      throw this.staleReadError(appId, environmentId, current.flag.id, current.version);
    }
    this.rememberExperimentSnapshot(appId, environmentId, current);
    return { flag: current.flag, version: current.version };
  }

  private async authoritativeReadError(
    appId: string,
    environmentId: string,
    key: string,
    label: string,
    missCode: ProviderError["errorCode"],
    cause: unknown,
  ): Promise<ProviderError> {
    let served: FlagConfigKV | undefined;
    try {
      served = await this.readBlob(key, parseFlagConfig, label, missCode);
    } catch {
      served = undefined;
    }
    const servedVersion =
      served === undefined ? 0 : (this.cache.servedVersion(appId, environmentId, served.id) ?? 0);
    const announced =
      served === undefined
        ? undefined
        : this.cache.announcedVersion(appId, environmentId, served.id);
    if (served !== undefined && announced !== undefined && announced.version > servedVersion) {
      return this.staleReadError(appId, environmentId, served.id, servedVersion, cause);
    }
    return new ProviderError("Authoritative Flag Configuration read is unavailable", {
      cause,
      errorCode: "SERVICE_UNAVAILABLE",
    });
  }

  private rememberExperimentSnapshot(
    appId: string,
    environmentId: string,
    current: EvaluationConfigSnapshot,
  ): void {
    const key = flagConfigKey(appId, environmentId, current.flag.key);
    const previousExperimentId = this.flagExperiments.get(key);
    if (previousExperimentId && previousExperimentId !== current.flag.experimentId) {
      this.experimentSnapshots.delete(
        experimentConfigKey(appId, environmentId, previousExperimentId),
      );
    }
    if (current.flag.experimentId === null) this.flagExperiments.delete(key);
    else this.flagExperiments.set(key, current.flag.experimentId);
    if (current.experiment !== null) {
      this.experimentSnapshots.set(
        experimentConfigKey(appId, environmentId, current.experiment.id),
        { experiment: current.experiment, run: current.run },
      );
    }
  }

  private staleReadError(
    appId: string,
    environmentId: string,
    flagId: string,
    servedVersion: number,
    cause?: unknown,
  ): ProviderError {
    const announced = this.cache.announcedVersion(appId, environmentId, flagId);
    const announcedVersion = announced?.version ?? servedVersion;
    const elapsedMs = announced === undefined ? 0 : Math.max(0, this.now() - announced.announcedAt);
    if (
      announced !== undefined &&
      announced.version > servedVersion &&
      elapsedMs >= PROPAGATION_BREACH_MS
    ) {
      this.options.onPropagationBreach?.({
        appId,
        environmentId,
        announcedVersion,
        servedVersion,
        elapsedMs,
      });
    }
    return new ProviderError(
      `Stale Flag Configuration ${appId}/${environmentId}/${flagId}: ` +
        `announced ${announcedVersion}, served ${servedVersion}, elapsed ${elapsedMs}ms`,
      { cause, errorCode: "SERVICE_UNAVAILABLE", resolutionReason: "STALE" },
    );
  }
}

const PROPAGATION_BREACH_MS = 5_000;
