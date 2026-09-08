import type { ConcludeRunRequest, TargetingRule } from "@splitch/contracts";
import type { Repository } from "@splitch/db";
import {
  type buildSnapshotFromD1,
  missingAvailableVariants,
  missingRuleVariantNames,
} from "./config-store-shared";
import type { FlagConfigResult } from "./config-store-types";
import {
  baselineIsUnresolvable,
  nextBaselineRollout,
  normalizeTargetingRuleRollouts,
} from "./flag-config-rollout";
import { validationErrors } from "./flag-definition-errors";
import { flagSegmentNotFound, rolloutAmbiguous } from "./flag-config-errors";
import { winnerChangedFields } from "./experiment-conclusion-policy";
import { variantNotAvailable } from "./experiment-errors";
import { resolveTargetingRules } from "./targeting-rule-resolution";

export interface WinnerProposalInput {
  appId: string;
  environmentId: string;
  experimentId: string;
  experimentFlagId: string;
  run: { variantSet: unknown };
  body: ConcludeRunRequest;
  conclusionId: string;
  requestId: string;
}

export type WinnerTargetSnapshot = NonNullable<Awaited<ReturnType<typeof buildSnapshotFromD1>>>;

export function validateSelectedVariant(
  input: WinnerProposalInput,
  snapshot: WinnerTargetSnapshot,
) {
  const selected = input.body.selectedVariant;
  if (!frozenVariantNames(input.run.variantSet).includes(selected)) {
    return invalid(
      input.requestId,
      "selectedVariant",
      "selected Variant must belong to the Run's frozen Variant set",
    );
  }
  if (!snapshot.flag.variants.some((variant) => variant.name === selected)) {
    return invalid(
      input.requestId,
      "selectedVariant",
      "selected Variant must exist in the target Flag's current Variant catalog",
    );
  }
  const available = input.body.target.proposedConfig.availableVariantNames;
  return available.length > 0 && !available.includes(selected)
    ? invalid(
        input.requestId,
        "target.proposedConfig.availableVariantNames",
        "selected Variant must be available in the proposed Configuration",
      )
    : null;
}

export async function normalizedWinnerRules(
  repo: Repository,
  input: WinnerProposalInput,
  current: FlagConfigResult,
  snapshot: WinnerTargetSnapshot,
) {
  const requested = input.body.target.proposedConfig;
  const duplicate = requested.targetingRules.find(
    (rule, index) => requested.targetingRules.findIndex((other) => other.id === rule.id) !== index,
  );
  if (duplicate) {
    return invalid(
      input.requestId,
      "target.proposedConfig.targetingRules",
      `Targeting Rule id ${duplicate.id} appears more than once`,
    );
  }
  const normalized = normalizeTargetingRuleRollouts(
    current.targetingRules,
    requested.targetingRules,
  );
  if (!normalized.ok) {
    return invalidTargetingRuleSalts(input.requestId, normalized.callerSaltIndexes);
  }
  if (normalized.targetingRules.some((rule) => rule.flagId !== input.body.target.flagId)) {
    return invalid(
      input.requestId,
      "target.proposedConfig.targetingRules",
      "every Targeting Rule must belong to the target Flag",
    );
  }
  const missing = [
    ...missingAvailableVariants(requested.availableVariantNames, snapshot.flag.variants),
    ...missingRuleVariantNames(
      normalized.targetingRules,
      snapshot.flag.variants,
      requested.availableVariantNames,
    ),
  ];
  if (missing.length > 0) {
    return {
      ok: false as const,
      response: variantNotAvailable(
        input.body.target.flagId,
        input.body.target.environmentId,
        [...new Set(missing)],
        input.requestId,
      ),
    };
  }
  const resolution = await resolveTargetingRules(repo, input.appId, normalized.targetingRules);
  return resolution.ok
    ? { ok: true as const, targetingRules: normalized.targetingRules }
    : {
        ok: false as const,
        response: flagSegmentNotFound(resolution.missingSegmentIds, input.requestId),
      };
}

export function buildWinnerConfig(
  input: WinnerProposalInput,
  current: FlagConfigResult,
  snapshot: WinnerTargetSnapshot,
  targetingRules: TargetingRule[],
) {
  const requested = input.body.target.proposedConfig;
  const rollout = nextBaselineRollout(current.rollout, requested.rollout, () =>
    input.conclusionId.slice(-16).toLowerCase(),
  );
  if (rollout === undefined) throw new Error("winner proposal must state rollout");
  const defaultVariant = snapshot.flag.variants.find(
    (variant) => variant.id === snapshot.flag.defaultVariantId,
  );
  if (
    baselineIsUnresolvable(
      rollout,
      requested.availableVariantNames,
      defaultVariant?.name,
      snapshot.flag.variants.map((variant) => variant.name),
    )
  ) {
    return {
      ok: false as const,
      response: rolloutAmbiguous(requested.availableVariantNames, input.requestId),
    };
  }
  const proposed: FlagConfigResult = {
    ...current,
    version: current.version + 1,
    enabled: requested.enabled,
    availableVariantNames: requested.availableVariantNames,
    targetingRules,
    rollout,
  };
  const changeTypes = winnerChangedFields(current, proposed);
  return changeTypes.length > 0
    ? { ok: true as const, proposed, changeTypes }
    : invalid(
        input.requestId,
        "target.proposedConfig",
        "proposed Configuration must change at least one field",
      );
}

function invalidTargetingRuleSalts(requestId: string, indexes: number[]) {
  return {
    ok: false as const,
    response: validationErrors(
      requestId,
      indexes.map((index) => ({
        path: [
          "body",
          "target",
          "proposedConfig",
          "targetingRules",
          String(index),
          "percentageRollout",
          "salt",
        ],
        message: "Targeting Rule bucketing salt is server-owned",
      })),
    ),
  };
}

function frozenVariantNames(value: unknown): string[] {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((variant) =>
    typeof variant === "object" &&
    variant !== null &&
    typeof (variant as { name?: unknown }).name === "string"
      ? [(variant as { name: string }).name]
      : [],
  );
}

function invalid(requestId: string, field: string, message: string) {
  return {
    ok: false as const,
    response: validationErrors(requestId, [{ path: ["body", ...field.split(".")], message }]),
  };
}
