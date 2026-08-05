import type {
  DeltaNudge,
  ExperimentConfigKV,
  FlagConfigKV,
  PercentageRollout,
  RunConfigKV,
  TargetingRule,
} from "@splitch/contracts";
import type { ApprovalCommit, Repository } from "@splitch/db";
import type { RunFrozenFailure } from "./flag-config-run-freeze";

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
  /** Controlling Experiment, or null when none controls this Flag here. */
  experiment: { id: string; name: string } | null;
}

export interface PatchFlagConfigInput {
  appId: string;
  environmentId: string;
  flagId: string;
  enabled?: boolean;
  availableVariantNames?: string[];
  /** Percentage only; the salt is the store's to mint and preserve. */
  rollout?: { percentage: number } | null;
  /** Internal deterministic mint used while replaying an approval proposal. */
  approvalRolloutSalt?: string;
  approval?: ApprovalCommit;
}

export interface ApplyApprovedFlagConfigInput {
  appId: string;
  environmentId: string;
  flagId: string;
  proposed: FlagConfigResult;
  /**
   * The Approval Request's own changed-field set (`diff.entries`). The Run-freeze
   * check keys off this, not a re-diff of `proposed` against live state
   * (SPL-304 / `flag-config-run-freeze-proposal.ts`).
   */
  diffEntries: readonly { path: string }[];
  approval: ApprovalCommit;
}

export interface ReplaceTargetingRulesInput {
  appId: string;
  environmentId: string;
  flagId: string;
  targetingRules: TargetingRule[];
  approval?: ApprovalCommit;
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
  /** Internal deterministic mint used while replaying an approval proposal. */
  approvalRolloutSalt?: string;
  approval?: ApprovalCommit;
  /** Internal dry-run used to construct the immutable Approval diff. */
  preview?: boolean;
}

/**
 * `ROLLOUT_AMBIGUOUS`: the write would leave a non-null baseline rollout with no
 * single non-Default available Variant to roll into (see config-store.ts).
 */
type FlagConfigWriteFailure =
  | { ok: false; reason: "FLAG_NOT_FOUND" }
  /**
   * The Approval-guarded D1 write selected zero rows, so no Review landed,
   * nothing was applied, and no KV snapshot was published. Distinct from
   * FLAG_NOT_FOUND, which means the Flag Configuration itself is gone.
   */
  | { ok: false; reason: "APPROVAL_NOT_APPLIED" }
  | { ok: false; reason: "VARIANT_NOT_AVAILABLE"; missingVariants: string[] }
  | { ok: false; reason: "ROLLOUT_AMBIGUOUS"; availableVariantNames: string[] }
  /**
   * The Approval Request's changed-field set could not be read. Fail closed: do
   * not apply a proposal whose freeze check cannot name what it would move
   * (SPL-304).
   */
  | { ok: false; reason: "CHANGED_FIELDS_UNDETERMINED" }
  /**
   * The request's entries touch no Flag Configuration field this write can
   * apply (for example only `/version` or `/experiment`). Refuse rather than
   * bump version and report applied while writing nothing (SPL-304).
   */
  | { ok: false; reason: "APPROVAL_EMPTY_CHANGE" }
  /**
   * A live Run in this Environment owns a field the write would move. Raised by
   * the store rather than by a route so every caller of the write — the
   * Configuration PATCH, the Targeting PUT, a Promotion into this Environment,
   * and an approved Approval Request — is refused by the same check
   * (flag-config-run-freeze.ts).
   */
  | RunFrozenFailure;

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
  /**
   * The RUNNING Experiment that owns part of this Flag Configuration, or null.
   *
   * Carried separately from `experiment` for two reasons: ExperimentConfigKV
   * deliberately holds only what the edge evaluate path needs (no display name),
   * and `experiment` is also populated for draft and ended Experiments, which own
   * nothing. Control-plane-only: never written to KV.
   */
  controllingExperiment: { id: string; name: string } | null;
}
