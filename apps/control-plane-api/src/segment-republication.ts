import { renderError } from "@splitch/worker-runtime";
import type { FlagConfigWriteResult } from "./config-store-types";
import { frozenTargetingFields, frozenWriteFailure } from "./flag-config-run-freeze";
import type { MetricSegmentDeps } from "./metric-segment-shared";
import type { SegmentDependencies } from "./segment-dependencies";

type FlagConfigurationDependency = SegmentDependencies["flagConfigurations"][number];
type RepublishedFlagConfiguration = Omit<FlagConfigurationDependency, "targetingRuleIds">;
type FlagConfigWriteFailure = Extract<FlagConfigWriteResult, { ok: false }>;
type WithoutOk<T> = T extends { ok: false } ? Omit<T, "ok"> : never;
type RepublishInfrastructureFailure = {
  reason: "CONFIG_STORE_UNAVAILABLE" | "UNEXPECTED_ERROR";
  fault?: string;
};

type NotRepublishedFlagConfiguration = RepublishedFlagConfiguration &
  (WithoutOk<FlagConfigWriteFailure> | RepublishInfrastructureFailure);

export interface SegmentRepublishFailure {
  /**
   * Whether the Segment row itself moved. False means the mutation was refused
   * before it touched D1, so the reported Flag Configurations are the ones that
   * blocked it rather than the ones that failed to catch up.
   */
  segmentApplied: boolean;
  republishedFlagConfigurations: RepublishedFlagConfiguration[];
  notRepublishedFlagConfigurations: NotRepublishedFlagConfiguration[];
}

type RepublishOutcome =
  | { ok: true; flagConfiguration: RepublishedFlagConfiguration }
  | { ok: false; flagConfiguration: NotRepublishedFlagConfiguration };

export async function republishFlagConfigurations(
  deps: MetricSegmentDeps,
  appId: string,
  dependencies: SegmentDependencies,
): Promise<SegmentRepublishFailure | null> {
  if (dependencies.flagConfigurations.length === 0) return null;
  const settled = await Promise.allSettled(
    dependencies.flagConfigurations.map((dependency) => republishOne(deps, appId, dependency)),
  );
  const outcomes = settled.map<RepublishOutcome>((outcome, index) => {
    if (outcome.status === "fulfilled") return outcome.value;
    const dependency = dependencies.flagConfigurations[index];
    if (!dependency) throw new Error("Segment republication lost dependency identity");
    return {
      ok: false,
      flagConfiguration: {
        ...flagConfigurationIdentity(dependency),
        reason: "UNEXPECTED_ERROR",
        fault: errorReason(outcome.reason),
      },
    };
  });
  const republishedFlagConfigurations = outcomes.flatMap((outcome) =>
    outcome.ok ? [outcome.flagConfiguration] : [],
  );
  const notRepublishedFlagConfigurations = outcomes.flatMap((outcome) =>
    outcome.ok ? [] : [outcome.flagConfiguration],
  );
  return notRepublishedFlagConfigurations.length > 0
    ? { segmentApplied: true, republishedFlagConfigurations, notRepublishedFlagConfigurations }
    : null;
}

/**
 * The freeze check for the Segment mutation itself, run BEFORE the D1 write.
 *
 * A refusal that only guards the fan-out is not durable. D1 is the source of
 * truth every later republication reads (`buildSnapshotFromD1` →
 * `resolveTargetingRules`), so Conditions committed ahead of a refused fan-out
 * publish themselves on the next unrelated Flag Configuration write — an
 * `enabled`-only PATCH is not frozen and carried the refused Conditions into KV.
 * Refusing ahead of the write means a retry after the Run ends re-enters from an
 * unmutated D1.
 *
 * Sequential rather than fanned out: the first frozen dependent already decides
 * the refusal, and every dependent is reported anyway.
 */
export async function frozenDependentsRefusal(
  deps: MetricSegmentDeps,
  appId: string,
  dependencies: SegmentDependencies,
): Promise<SegmentRepublishFailure | null> {
  const frozen: NotRepublishedFlagConfiguration[] = [];
  for (const dependency of dependencies.flagConfigurations) {
    const failure = await frozenWriteFailure(
      deps.repo,
      { appId, environmentId: dependency.environmentId, flagId: dependency.flagId },
      frozenTargetingFields(),
      "UPDATE_SEGMENT_CONDITIONS",
    );
    if (!failure) continue;
    frozen.push({
      ...flagConfigurationIdentity(dependency),
      reason: failure.reason,
      frozenFields: failure.frozenFields,
      currentRunId: failure.currentRunId,
      attemptedChange: failure.attemptedChange,
    });
  }
  return frozen.length > 0
    ? {
        segmentApplied: false,
        republishedFlagConfigurations: [],
        notRepublishedFlagConfigurations: frozen,
      }
    : null;
}

async function republishOne(
  deps: MetricSegmentDeps,
  appId: string,
  dependency: FlagConfigurationDependency,
): Promise<RepublishOutcome> {
  const identity = flagConfigurationIdentity(dependency);
  if (!deps.configStore) {
    return {
      ok: false,
      flagConfiguration: { ...identity, reason: "CONFIG_STORE_UNAVAILABLE" },
    };
  }
  const result = await deps.configStore
    .writerFor(appId, dependency.environmentId)
    .resyncFlagConfig({
      appId,
      environmentId: dependency.environmentId,
      flagId: dependency.flagId,
    });
  return result.ok
    ? { ok: true, flagConfiguration: identity }
    : { ok: false, flagConfiguration: writeFailure(identity, result) };
}

function writeFailure(
  identity: RepublishedFlagConfiguration,
  failure: FlagConfigWriteFailure,
): NotRepublishedFlagConfiguration {
  switch (failure.reason) {
    case "RUN_FROZEN":
      return {
        ...identity,
        reason: failure.reason,
        frozenFields: failure.frozenFields,
        currentRunId: failure.currentRunId,
        attemptedChange: failure.attemptedChange,
      };
    case "VARIANT_NOT_AVAILABLE":
      return { ...identity, reason: failure.reason, missingVariants: failure.missingVariants };
    case "SEGMENT_NOT_FOUND":
      return { ...identity, reason: failure.reason, missingSegmentIds: failure.missingSegmentIds };
    case "ROLLOUT_AMBIGUOUS":
      return {
        ...identity,
        reason: failure.reason,
        availableVariantNames: failure.availableVariantNames,
      };
    case "TARGETING_RULE_ID_CONFLICT":
      return { ...identity, reason: failure.reason, targetingRules: failure.targetingRules };
    case "TARGETING_RULE_SALT_REJECTED":
      return { ...identity, reason: failure.reason, callerSaltIndexes: failure.callerSaltIndexes };
    default:
      return { ...identity, reason: failure.reason };
  }
}

function flagConfigurationIdentity(
  dependency: FlagConfigurationDependency,
): RepublishedFlagConfiguration {
  const { targetingRuleIds: _, ...identity } = dependency;
  return identity;
}

function errorReason(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function republishApplicationError(failure: SegmentRepublishFailure) {
  const { segmentApplied: _, ...lists } = failure;
  const frozen = failure.notRepublishedFlagConfigurations.filter(
    (configuration) => configuration.reason === "RUN_FROZEN",
  );
  if (frozen.length === failure.notRepublishedFlagConfigurations.length) {
    const first = frozen[0];
    if (!(first?.currentRunId && first.attemptedChange && first.frozenFields)) {
      throw new Error("RUN_FROZEN republication failure is missing refusal details");
    }
    return {
      code: "RUN_FROZEN" as const,
      message: republishMessage(failure, " because a Run is active"),
      details: {
        frozenFields: [
          ...new Set(frozen.flatMap((configuration) => configuration.frozenFields ?? [])),
        ],
        currentRunId: first.currentRunId,
        attemptedChange: first.attemptedChange,
        recommendedAction: "END_RUNNING_RUN_FIRST" as const,
        ...lists,
      },
    };
  }
  return {
    code: "INTERNAL_SERVER_ERROR" as const,
    message: republishMessage(failure),
    details: { ...lists },
  };
}

function republishMessage(failure: SegmentRepublishFailure, suffix = "") {
  if (!failure.segmentApplied) {
    return `Segment Conditions were not changed${suffix}`;
  }
  return failure.republishedFlagConfigurations.length === 0
    ? `Segment changed, but dependent Flag Configurations were not republished${suffix}`
    : `Segment changed, but some dependent Flag Configurations were not republished${suffix}`;
}

export function renderRepublishFailure(requestId: string, failure: SegmentRepublishFailure) {
  return renderError(republishApplicationError(failure), { requestId });
}
