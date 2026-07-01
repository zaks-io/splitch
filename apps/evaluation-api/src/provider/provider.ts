import type { ErrorCode, ExperimentStatus, TargetingRule, Variant } from "@splitch/contracts";
import type { RunConfig } from "../assignment/run-config.js";

/**
 * The Provider port: a STATELESS read-side resolver (ADR-0007). Its only state is
 * an invalidatable cache of flag config (see cache.ts). It never holds per-Entity
 * assignment memory — that is the Assignment Store, a sibling seam, never behind
 * the Provider.
 *
 * The interface is the seam: the evaluate path consumes these resolved VIEWS
 * (FlagConfig / ExperimentConfig) and never touches a KV blob. A second adapter
 * (e.g. flagd reference) returns the same shapes, so the deletion test holds.
 *
 * See docs/spec/evaluation/provider-port.md.
 */
export interface Provider {
  /**
   * Resolve live Run config for one Experiment in one Environment. The
   * Experiment carries `liveRun` hydrated INLINE (one resolution, not a second
   * round-trip the caller must make).
   */
  getExperiment(
    appId: string,
    environmentId: string,
    experimentId: string,
  ): Promise<ExperimentConfig>;

  /**
   * Resolve Flag Configuration + Targeting rules for the evaluate path. The
   * controlling `experimentId` is read in THIS call (it is denormalized on
   * FlagConfigKV), so flag -> experiment never needs a second lookup that could
   * disagree with the flag read.
   */
  getFlag(appId: string, environmentId: string, flagKey: string): Promise<FlagConfig>;

  /** Bulk fetch every Flag Configuration for an Environment (request-start preload). */
  getFlags(appId: string, environmentId: string): Promise<FlagConfig[]>;
}

/**
 * Resolved Flag Configuration the evaluate path reads. The evaluate path works in
 * Variant NAMES throughout, so the stored `defaultVariantId` (an id) is resolved
 * here into `defaultVariant` (the name). `experimentId` is the controlling
 * Experiment in this Environment, or null — read in the same getFlag call.
 *
 * This is a VIEW, not a KV blob: the storage shape (FlagConfigKV) can change
 * without touching the evaluate path.
 */
export interface FlagConfig {
  flagKey: string;
  appId: string;
  environmentId: string;
  experimentId: string | null;
  enabled: boolean;
  /** Variant NAME returned when disabled or no rule matches (resolved from the stored id). */
  defaultVariant: string;
  variants: Variant[];
  targetingRules: TargetingRule[];
}

/**
 * Resolved Experiment Configuration with the live Run hydrated inline. `liveRun`
 * is the frozen, assign()-shaped RunConfig (or null before the first Start), so
 * the caller passes it straight to assign() without resolving a second shape.
 *
 * `targetingKeyType` (the Entity type, e.g. "user") is the id_type the
 * Exposure-firing slice stamps on each Exposure — surfaced here so that slice
 * needs no second resolution (the exact smell this seam prevents). `status` is
 * the lifecycle state (provider-port.md marks it Required).
 */
export interface ExperimentConfig {
  experimentId: string;
  appId: string;
  environmentId: string;
  targetingKeyType: string;
  status: ExperimentStatus;
  liveRunId: string | null;
  liveRun: RunConfig | null;
}

/**
 * A loud Provider failure. A malformed/partial KV blob, a missing key, or any
 * resolution fault throws this — never a half-valid view into assign() (fail-loud,
 * ADR-0036/0025). It carries a stable `errorCode` (always INTERNAL_SERVER_ERROR
 * for this seam) so the evaluate-path orchestration maps it to `reason: ERROR` +
 * the code, fires no Exposure, and logs loudly. The failure is always observable
 * in the result, never a silent default.
 */
export class ProviderError extends Error {
  readonly errorCode: ErrorCode;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ProviderError";
    this.errorCode = "INTERNAL_SERVER_ERROR";
  }
}
