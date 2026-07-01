import type { DeltaNudge, ExperimentConfigKV, FlagConfigKV, RunConfigKV } from "@splitch/contracts";
import {
  experimentConfigKey,
  ExperimentConfigKVSchema,
  flagConfigKey,
  FlagConfigKVSchema,
  kvEnvelope,
  runConfigKey,
  RunConfigKVSchema,
} from "@splitch/contracts";
import { FlagConfigCache } from "./cache.js";
import {
  type ExperimentConfig,
  type FlagConfig,
  type Provider,
  ProviderError,
} from "./provider.js";
import { experimentConfigFromKV, flagConfigFromKV } from "./resolve.js";

/**
 * KV-backed Provider adapter. Read-side ONLY: it reads app-scoped KV keys, parses
 * every blob, and resolves them into evaluate-path views. It never writes — the
 * platform write path is a different seam — and it never reaches D1.
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
  list(options: { prefix: string }): Promise<{ keys: { name: string }[] }>;
}

/**
 * Typed envelope parsers. Each wraps `kvEnvelope(payload).safeParse` so the
 * adapter never references zod's types directly (evaluation-api has no zod dep);
 * the inner KV payload type is asserted by the contract schema, so the closure's
 * return type is the concrete KV shape. A failure yields a stable error string the
 * read boundary turns into a ProviderError.
 */
type BlobParse<T> = (json: unknown) => { ok: true; value: T } | { ok: false; error: string };

function blobParser<T>(envelope: { safeParse: (json: unknown) => SafeParse<T> }): BlobParse<T> {
  return (json) => {
    const parsed = envelope.safeParse(json);
    return parsed.success
      ? { ok: true, value: parsed.data.data }
      : { ok: false, error: parsed.error.message };
  };
}

type SafeParse<T> =
  | { success: true; data: { data: T } }
  | { success: false; error: { message: string } };

const parseFlagConfig = blobParser<FlagConfigKV>(kvEnvelope(FlagConfigKVSchema));
const parseExperimentConfig = blobParser<ExperimentConfigKV>(kvEnvelope(ExperimentConfigKVSchema));
const parseRunConfig = blobParser<RunConfigKV>(kvEnvelope(RunConfigKVSchema));

export class KvProvider implements Provider {
  private readonly cache = new FlagConfigCache();

  constructor(private readonly kv: KvReader) {}

  async getFlag(appId: string, environmentId: string, flagKey: string): Promise<FlagConfig> {
    const key = flagConfigKey(appId, environmentId, flagKey);

    const cached = this.cache.get(key);
    if (cached !== undefined) {
      return cached;
    }

    // ONE read: experimentId is denormalized on the flag blob, so flag ->
    // experiment never needs a second KV get here.
    const blob = await this.readBlob(key, parseFlagConfig, `flag ${flagKey}`);
    const config = flagConfigFromKV(appId, blob);
    this.cache.set(key, config);
    return config;
  }

  async getFlags(appId: string, environmentId: string): Promise<FlagConfig[]> {
    const prefix = `app:${appId}:${environmentId}:flag:`;
    const { keys } = await this.kv.list({ prefix });

    return Promise.all(
      keys.map(async ({ name }) => {
        const cached = this.cache.get(name);
        if (cached !== undefined) {
          return cached;
        }
        const blob = await this.readBlob(name, parseFlagConfig, name);
        const config = flagConfigFromKV(appId, blob);
        this.cache.set(name, config);
        return config;
      }),
    );
  }

  async getExperiment(
    appId: string,
    environmentId: string,
    experimentId: string,
  ): Promise<ExperimentConfig> {
    const experiment = await this.readBlob(
      experimentConfigKey(appId, environmentId, experimentId),
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

  /** Invalidate one App's cached flag config on a WebSocket DeltaNudge (ADR-0019). */
  invalidate(appId: string, nudge: DeltaNudge): void {
    this.cache.invalidateApp(appId, nudge);
  }

  /**
   * Read + parse one KV blob, fail-loud. A miss, malformed JSON, unknown schema
   * version, or schema violation throws a ProviderError — a partial/half-valid
   * object must never escape this boundary.
   */
  private async readBlob<T>(key: string, parse: BlobParse<T>, label: string): Promise<T> {
    const raw = await this.kv.get(key);
    if (raw === null) {
      throw new ProviderError(`KV miss for ${label} (key "${key}")`);
    }

    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch (cause) {
      throw new ProviderError(`Malformed JSON for ${label} (key "${key}")`, { cause });
    }

    const parsed = parse(json);
    if (!parsed.ok) {
      throw new ProviderError(`Invalid KV blob for ${label} (key "${key}"): ${parsed.error}`);
    }
    return parsed.value;
  }
}
