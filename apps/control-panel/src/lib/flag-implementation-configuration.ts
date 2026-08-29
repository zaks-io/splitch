import type { Condition, Segment, Variant } from "@splitch/contracts";
import type { PanelSegmentsListOutput } from "@splitch/control-plane-sdk";
import type { FlagDetailData } from "./flag-detail-data";
import type { FlagDetailView } from "./flag-detail-view";
import type { FlagImplementationInput } from "./implementation-prompt";

export function flagImplementationConfiguration(
  data: FlagDetailData,
  segmentList: PanelSegmentsListOutput,
): FlagImplementationInput["flag"] {
  const config = data.configuration;
  const catalog = data.definition.variants;
  const available = config?.availableVariantNames ?? [];
  const narrowed = available.length > 0;

  return {
    key: data.definition.key,
    configured: config !== null,
    enabled: config?.enabled ?? false,
    defaultVariant: variantName(catalog, data.definition.defaultVariantId),
    availableVariantNames: available,
    variants: catalog.map((variant) => ({
      name: variant.name,
      valueJson: JSON.stringify(variant.value),
      isDefault: variant.id === data.definition.defaultVariantId,
      availability: availabilityOf(variant, config === null, narrowed, available),
    })),
    targetingRules: (config?.targetingRules ?? [])
      .slice()
      .sort((a, b) => a.priority - b.priority)
      .map((rule) => {
        const segment = rule.segmentId
          ? referencedSegment(segmentList.items, rule.segmentId)
          : null;
        return {
          id: rule.id,
          priority: rule.priority,
          variant: variantName(catalog, rule.variantId),
          conditions: implementationConditions(rule.conditions),
          segment: segment
            ? {
                id: segment.id,
                name: segment.name,
                conditions: implementationConditions(segment.conditions),
              }
            : null,
          rolloutPercentage: rule.percentageRollout?.percentage ?? null,
        };
      }),
    baselineRolloutPercentage: config?.rollout?.percentage ?? null,
  };
}

export function flagImplementationConfigurationFromView(
  view: FlagDetailView,
): FlagImplementationInput["flag"] {
  return {
    key: view.key,
    configured: view.configured,
    enabled: view.enabled,
    defaultVariant: view.defaultVariantName,
    availableVariantNames: view.availabilityNarrowed
      ? view.catalog
          .filter((variant) => variant.availability === "available")
          .map((variant) => variant.name)
      : [],
    variants: view.catalog.map((variant) => ({
      name: variant.name,
      valueJson: variant.value,
      isDefault: variant.isDefault,
      availability: variant.availability,
    })),
    targetingRules: view.targetingRules.map((rule) => ({
      id: rule.id,
      priority: rule.priority,
      variant: rule.variantName,
      conditions: rule.conditions,
      segment:
        rule.segmentId && rule.segmentName
          ? {
              id: rule.segmentId,
              name: rule.segmentName,
              conditions: rule.segmentConditions,
            }
          : null,
      rolloutPercentage: rule.rolloutPercentage,
    })),
    baselineRolloutPercentage: view.baselineRolloutPercentage,
  };
}

function availabilityOf(
  variant: Variant,
  unconfigured: boolean,
  narrowed: boolean,
  available: string[],
): FlagImplementationInput["flag"]["variants"][number]["availability"] {
  if (unconfigured) return "unavailable";
  if (!narrowed) return "not-narrowed";
  return available.includes(variant.name) ? "available" : "unavailable";
}

function variantName(catalog: Variant[], variantId: string): string {
  return catalog.find((variant) => variant.id === variantId)?.name ?? variantId;
}

function referencedSegment(segments: Segment[], segmentId: string): Segment {
  const segment = segments.find((candidate) => candidate.id === segmentId);
  if (!segment) {
    throw new Error(`Flag Configuration references an unavailable Segment: ${segmentId}`);
  }
  return segment;
}

function implementationConditions(conditions: Condition[]) {
  return conditions.map((condition) => ({
    attribute: condition.attribute,
    operator: condition.operator,
    value: condition.value,
  }));
}
