import { FLAG_STALE_THRESHOLDS } from "./flag-stale-thresholds";
import type { StoredFlagLifecycleClass } from "./leaf-schemas-flag";

/** Ordinary Flag reads record no served Variant, so serving stays unverified. */
export const SERVING_EVIDENCE_UNVERIFIED = "unverified" as const;
export type ServingEvidence = typeof SERVING_EVIDENCE_UNVERIFIED;

export type UniformServingMode = "disabled" | "default_only" | "full_rollout";

/**
 * One Environment's configuration facts used for uniform-serving detection.
 * `hasRunningExperiment` excludes live experiment control from "static uniform".
 */
export type EnvironmentConfigState = {
  environmentId: string;
  enabled: boolean;
  targetingRuleCount: number;
  /** Baseline rollout percentage, or null when there is no baseline rollout. */
  rolloutPercentage: number | null;
  hasRunningExperiment: boolean;
  /** Last write to this Flag Configuration (ISO UTC). */
  updatedAt: string;
  /**
   * Latest Run Start/End/Conclude instant for this Flag in this Environment, or
   * null when no Run has touched it. End updates the Run, not the Configuration,
   * so uniform serving cannot start until after that lifecycle instant.
   */
  lastRunLifecycleAt: string | null;
};

export type UniformEnvironmentEvidence = {
  environmentId: string;
  mode: UniformServingMode;
  updatedAt: string;
};

export type StaleReason =
  | {
      kind: "uniform_serving";
      thresholdDays: number;
      /** Latest Environment config `updatedAt` across the App; uniform at least this long. */
      uniformSince: string;
      environments: UniformEnvironmentEvidence[];
    }
  | {
      kind: "past_expiry";
      expiresAt: string;
      lifecycleClass: StoredFlagLifecycleClass;
    }
  | {
      kind: "unchanged";
      thresholdDays: number;
      lastChangedAt: string;
      /** Where `lastChangedAt` came from so agents do not invent a second clock. */
      source: "flag_change_log" | "flag_updated_at";
    };

export type StaleFlagSignals = {
  reasons: StaleReason[];
  servingEvidence: ServingEvidence;
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Whether one Environment serves a single Variant to everyone from configuration
 * state alone: no Targeting Rules, and either disabled, default-only (null/0%
 * rollout), or 100% baseline rollout. A running Experiment is never uniform.
 */
export function uniformServingMode(config: EnvironmentConfigState): UniformServingMode | null {
  if (config.hasRunningExperiment) return null;
  if (config.targetingRuleCount !== 0) return null;
  if (!config.enabled) return "disabled";
  if (config.rolloutPercentage === null || config.rolloutPercentage === 0) return "default_only";
  if (config.rolloutPercentage === 100) return "full_rollout";
  return null;
}

export function daysBetween(earlierIso: string, laterIso: string): number {
  const earlier = Date.parse(earlierIso);
  const later = Date.parse(laterIso);
  if (!Number.isFinite(earlier) || !Number.isFinite(later)) {
    throw new Error(`daysBetween: need valid ISO instants, got ${earlierIso} and ${laterIso}`);
  }
  return (later - earlier) / MS_PER_DAY;
}

/**
 * Collect typed stale reasons for one Flag. Suggest-only: never writes.
 * Always labels serving as unverified; never claims the Flag is unused.
 */
export function detectStaleReasons(input: {
  lifecycleClass: StoredFlagLifecycleClass;
  expiresAt: string | null;
  /** Flag definition `updatedAt` (fallback when the change log has no row). */
  flagUpdatedAt: string;
  /** Latest change-log `changedAt` for this Flag, when known. */
  lastChangeLogAt: string | null;
  configurations: readonly EnvironmentConfigState[];
  now: string;
}): StaleFlagSignals {
  if (input.configurations.length === 0) {
    throw new Error("detectStaleReasons: a Flag with no Environment configurations is incomplete");
  }

  const reasons: StaleReason[] = [];
  const thresholds = FLAG_STALE_THRESHOLDS[input.lifecycleClass];

  if (input.expiresAt !== null && Date.parse(input.expiresAt) <= Date.parse(input.now)) {
    reasons.push({
      kind: "past_expiry",
      expiresAt: input.expiresAt,
      lifecycleClass: input.lifecycleClass,
    });
  }

  if (thresholds.uniformServingDays !== null) {
    const uniform = tryUniformServingReason(
      input.configurations,
      thresholds.uniformServingDays,
      input.now,
    );
    if (uniform) reasons.push(uniform);
  }

  if (thresholds.unchangedDays !== null) {
    const unchanged = tryUnchangedReason(
      input.lastChangeLogAt,
      input.flagUpdatedAt,
      thresholds.unchangedDays,
      input.now,
    );
    if (unchanged) reasons.push(unchanged);
  }

  return { reasons, servingEvidence: SERVING_EVIDENCE_UNVERIFIED };
}

function tryUniformServingReason(
  configurations: readonly EnvironmentConfigState[],
  thresholdDays: number,
  now: string,
): StaleReason | null {
  const environments: UniformEnvironmentEvidence[] = [];
  let uniformSince: string | null = null;
  for (const config of configurations) {
    const mode = uniformServingMode(config);
    if (mode === null) return null;
    environments.push({ environmentId: config.environmentId, mode, updatedAt: config.updatedAt });
    const envSince = uniformServingStart(config);
    if (uniformSince === null || envSince > uniformSince) uniformSince = envSince;
  }
  if (uniformSince === null) return null;
  if (daysBetween(uniformSince, now) < thresholdDays) return null;
  return {
    kind: "uniform_serving",
    thresholdDays,
    uniformSince,
    environments,
  };
}

/** Latest of Configuration change and any Run lifecycle change in that Environment. */
function uniformServingStart(config: EnvironmentConfigState): string {
  if (config.lastRunLifecycleAt === null) return config.updatedAt;
  return config.lastRunLifecycleAt > config.updatedAt
    ? config.lastRunLifecycleAt
    : config.updatedAt;
}

function tryUnchangedReason(
  lastChangeLogAt: string | null,
  flagUpdatedAt: string,
  thresholdDays: number,
  now: string,
): StaleReason | null {
  const lastChangedAt = lastChangeLogAt ?? flagUpdatedAt;
  const source = lastChangeLogAt === null ? "flag_updated_at" : "flag_change_log";
  if (daysBetween(lastChangedAt, now) < thresholdDays) return null;
  return { kind: "unchanged", thresholdDays, lastChangedAt, source };
}
