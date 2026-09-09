import { type ConcludeRunRequest, ConcludeRunRequestSchema } from "@splitch/contracts";
import type { PanelSegmentsListOutput } from "@splitch/control-plane-sdk";

export interface ConclusionTarget {
  environmentId: string;
  flagId: string;
  version: number;
  enabled: boolean;
  availableVariantNames: string[];
  targetingRulesJson: string;
  rolloutPercentage: number | null;
  variants: Array<{ id: string; name: string }>;
  segments: PanelSegmentsListOutput["items"];
}

export interface ConclusionDraft {
  selectedVariant: string;
  enabled: boolean;
  availableVariantNames: string[];
  targetingRulesJson: string;
  rolloutPercentage: string;
  hasRollout: boolean;
  reason: string;
}

export function conclusionDraft(target: ConclusionTarget): ConclusionDraft {
  return {
    selectedVariant: "",
    enabled: target.enabled,
    availableVariantNames: target.availableVariantNames,
    targetingRulesJson: target.targetingRulesJson,
    hasRollout: target.rolloutPercentage !== null,
    rolloutPercentage: target.rolloutPercentage === null ? "" : String(target.rolloutPercentage),
    reason: "",
  };
}

export function conclusionRequest(input: {
  draft: ConclusionDraft;
  target: ConclusionTarget;
  expectedResultToken: string;
  dataWatermark: string;
  idempotencyKey: string;
}): { ok: true; request: ConcludeRunRequest } | { ok: false; message: string } {
  let targetingRules: unknown;
  try {
    targetingRules = JSON.parse(input.draft.targetingRulesJson);
  } catch {
    return { ok: false, message: "Targeting Rules must be valid JSON." };
  }
  const { draft, target } = input;
  if (draft.hasRollout && draft.rolloutPercentage.trim() === "") {
    return { ok: false, message: "Enter a rollout percentage." };
  }
  const parsed = ConcludeRunRequestSchema.safeParse({
    selectedVariant: draft.selectedVariant,
    expectedResultToken: input.expectedResultToken,
    dataWatermark: input.dataWatermark,
    target: {
      environmentId: target.environmentId,
      flagId: target.flagId,
      expectedConfigVersion: target.version,
      proposedConfig: {
        enabled: draft.enabled,
        availableVariantNames: draft.availableVariantNames,
        targetingRules,
        rollout: draft.hasRollout ? { percentage: Number(draft.rolloutPercentage) } : null,
      },
    },
    review: { action: "approve_and_apply" },
    ...(draft.reason.trim() ? { reason: draft.reason.trim() } : {}),
    idempotencyKey: input.idempotencyKey,
  });
  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues.map((issue) => issue.message).join(" ") };
  }
  if (
    draft.availableVariantNames.length > 0 &&
    !draft.availableVariantNames.includes(draft.selectedVariant)
  ) {
    return { ok: false, message: "Make the selected Variant available in the target Environment." };
  }
  return { ok: true, request: parsed.data };
}

export interface ConclusionScope {
  appId: string;
  environmentId: string;
  experimentId: string;
  flagId: string;
  runId: string;
}
