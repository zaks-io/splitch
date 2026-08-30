import type { Condition, Segment, Variant } from "@splitch/contracts";
import type { PanelSegmentsListOutput } from "@splitch/control-plane-sdk";
import type { FlagDetailData } from "#lib/flags/flag-detail-data";
import type { FlagDetailView } from "#lib/flags/flag-detail-view";
import type { FlagImplementationInput } from "#lib/connect/implementation-prompt";

export function flagImplementationConfiguration(
  data: FlagDetailData,
  segmentList: PanelSegmentsListOutput,
): FlagImplementationInput["flag"] {
  const config = data.configuration;
  const catalog = data.definition.variants;
  const available = config?.availableVariantNames ?? [];
  const narrowed = available.length > 0;
  assertAvailableVariants(catalog, available);

  return {
    key: data.definition.key,
    configured: config !== null,
    enabled: config?.enabled ?? false,
    defaultVariant: requiredVariantName(catalog, data.definition.defaultVariantId, "Default"),
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
          variant: requiredVariantName(catalog, rule.variantId, `Targeting Rule ${rule.id}`),
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
  const catalogNames = new Set(view.catalog.map((variant) => variant.name));
  if (!catalogNames.has(view.defaultVariantName)) {
    throw new Error(
      `Default Variant is unavailable from the Flag catalog: ${view.defaultVariantName}`,
    );
  }
  assertAvailableVariants(view.catalog, view.availableVariantNames);
  for (const rule of view.targetingRules) {
    if (!catalogNames.has(rule.variantName)) {
      throw new Error(
        `Targeting Rule ${rule.id} references an unavailable Variant: ${rule.variantName}`,
      );
    }
  }

  return {
    key: view.key,
    configured: view.configured,
    enabled: view.enabled,
    defaultVariant: view.defaultVariantName,
    availableVariantNames: view.availableVariantNames,
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

function requiredVariantName(catalog: Variant[], variantId: string, source: string): string {
  const variant = catalog.find((candidate) => candidate.id === variantId);
  if (!variant) {
    throw new Error(`${source} references an unavailable Variant: ${variantId}`);
  }
  return variant.name;
}

function assertAvailableVariants(
  catalog: readonly { name: string }[],
  available: readonly string[],
): void {
  const catalogNames = new Set(catalog.map((variant) => variant.name));
  const missing = available.find((name) => !catalogNames.has(name));
  if (missing) {
    throw new Error(`Flag Configuration marks an unavailable Variant as available: ${missing}`);
  }
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
