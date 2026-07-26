import type {
  DeltaNudge,
  ExperimentConfigKV,
  FlagConfigKV,
  PercentageRollout,
  RunConfigKV,
  TargetingRule,
} from "@splitch/contracts";
import type { Repository } from "@splitch/db";

/**
 * The config store's data shapes: what callers hand in, what they get back, and
 * the in-memory Snapshot the store assembles from D1 before it reaches KV.
 * Kept apart from the behaviour in config-store-shared.ts so the store's contract
 * reads on one screen.
 */

export interface FlagConfigResult {
  flagId: string;
  environmentId: string;
  version: number;
  enabled: boolean;
  availableVariantNames: string[];
  targetingRules: TargetingRule[];
  rollout: PercentageRollout | null;
}

export interface PatchFlagConfigInput {
  appId: string;
  environmentId: string;
  flagId: string;
  enabled?: boolean;
  availableVariantNames?: string[];
  /** Percentage only; the salt is the store's to mint and preserve. */
  rollout?: { percentage: number } | null;
}

export interface ReplaceTargetingRulesInput {
  appId: string;
  environmentId: string;
  flagId: string;
  targetingRules: TargetingRule[];
}

export interface PromoteFlagConfigInput {
  appId: string;
  targetEnvironmentId: string;
  flagId: string;
  fromEnvironmentId: string;
  select: {
    availability?: string[];
    targeting?: true;
    rollout?: true;
    enabled?: true;
  };
}

/**
 * `ROLLOUT_AMBIGUOUS`: the write would leave a non-null baseline rollout with no
 * single non-Default available Variant to roll into (see config-store.ts).
 */
type FlagConfigWriteFailure =
  | { ok: false; reason: "FLAG_NOT_FOUND" }
  | { ok: false; reason: "VARIANT_NOT_AVAILABLE"; missingVariants: string[] }
  | { ok: false; reason: "ROLLOUT_AMBIGUOUS"; availableVariantNames: string[] };

export type FlagConfigWriteResult =
  | { ok: true; config: FlagConfigResult; nudge: DeltaNudge }
  | FlagConfigWriteFailure;

export type PromoteFlagConfigResult =
  | {
      ok: true;
      config: FlagConfigResult;
      diff: { before: FlagConfigResult; after: FlagConfigResult };
      nudge: DeltaNudge;
    }
  | FlagConfigWriteFailure;

export interface ConfigStoreDeps {
  repo: Repository;
  kv: KVNamespace;
  broadcaster: { broadcast(nudge: DeltaNudge): Promise<void> | void };
  logger?: Pick<Console, "warn">;
  now?: () => Date;
}

export interface Snapshot {
  flag: FlagConfigKV;
  experiment: ExperimentConfigKV | null;
  run: RunConfigKV | null;
  version: number;
}
