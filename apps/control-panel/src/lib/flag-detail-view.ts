import type { Variant } from "@splitch/contracts";
import type { FlagDetailData } from "./flag-detail-data";

/**
 * The read-only view model for the Flag detail screen.
 *
 * Pure and Worker-truth-only: every field below is derived from what the Flag
 * Configuration read returned. Nothing here invents a lock, an availability, or a
 * served Variant that the Worker did not report.
 */

/**
 * `not-narrowed` is NOT a synonym for available. An empty `availableVariantNames`
 * means the Configuration was never narrowed (it is initialized empty), so the
 * whole catalog is the candidate set — the opposite of "nothing can serve here"
 * (flag-editing-ux.md). Rendering it as its own state is what stops the screen
 * from lying in either direction.
 */
type VariantAvailability = "available" | "unavailable" | "not-narrowed";

export type CatalogVariantView = {
  id: string;
  name: string;
  /** JSON-rendered so `false`, `"false"`, and `0` stay distinguishable. */
  value: string;
  isDefault: boolean;
  availability: VariantAvailability;
};

type TargetingRuleView = {
  id: string;
  priority: number;
  /** Catalog name of the served Variant, or the raw id if it left the catalog. */
  variantName: string;
  conditions: Array<{ attribute: string; operator: string; value: string }>;
  rolloutPercentage: number | null;
};

/**
 * Field groups the screen locks. `kill-switch` is listed so the exemption is
 * expressed in the model and testable, never left implicit in markup.
 */
export type FlagDetailFieldGroup = "availability" | "targeting" | "rollout" | "kill-switch";

export type FlagDetailView = {
  /** The mutation address of this Flag; the URL carries the human `key`. */
  flagId: string;
  key: string;
  name: string;
  description?: string;
  env: string;
  /** JSON text, or `null` when unconstrained: any Variant value passes. */
  schema: string | null;
  /** No Configuration in this Environment yet; nothing is servable here. */
  configured: boolean;
  enabled: boolean;
  catalog: CatalogVariantView[];
  availableVariantCount: number;
  availabilityNarrowed: boolean;
  defaultVariantName: string;
  targetingRules: TargetingRuleView[];
  baselineRolloutPercentage: number | null;
  /** The running Experiment that owns some of these fields, or null. */
  controllingExperiment: { id: string; name: string } | null;
};

export function flagDetailView(data: FlagDetailData, env: string): FlagDetailView {
  const config = data.configuration;
  const catalog = data.definition.variants;
  const available = config ? config.availableVariantNames : [];
  const narrowed = available.length > 0;

  return {
    flagId: data.definition.id,
    key: data.definition.key,
    name: data.definition.name,
    ...(data.definition.description ? { description: data.definition.description } : {}),
    env,
    schema: data.definition.schema ? JSON.stringify(data.definition.schema) : null,
    configured: config !== null,
    enabled: config?.enabled ?? false,
    catalog: catalog.map((variant) => ({
      id: variant.id,
      name: variant.name,
      value: JSON.stringify(variant.value),
      isDefault: variant.id === data.definition.defaultVariantId,
      availability: availabilityOf(variant, config === null, narrowed, available),
    })),
    availableVariantCount: available.length,
    availabilityNarrowed: narrowed,
    defaultVariantName: variantName(catalog, data.definition.defaultVariantId),
    targetingRules: (config?.targetingRules ?? [])
      .slice()
      .sort((a, b) => a.priority - b.priority)
      .map((rule) => ({
        id: rule.id,
        priority: rule.priority,
        variantName: variantName(catalog, rule.variantId),
        conditions: rule.conditions.map((condition) => ({
          attribute: condition.attribute,
          operator: condition.operator,
          value: JSON.stringify(condition.value),
        })),
        rolloutPercentage: rule.percentageRollout?.percentage ?? null,
      })),
    baselineRolloutPercentage: config?.rollout?.percentage ?? null,
    controllingExperiment: config?.experiment ?? null,
  };
}

/**
 * What a running Experiment's Run owns here, and it owns it in the WORKER: the
 * Configuration PATCH and the Targeting replace both refuse these field groups
 * with `RUN_FROZEN` while the Run is live (flag-editing-ux.md, validation-policy.md).
 * This function decides an affordance for an enforced refusal; it does not invent
 * one, which is the only reason the screen is allowed to claim a lock at all
 * (ADR-0023).
 *
 * The baseline rollout is included because a live Run's allocation is the sole
 * authority for its traffic — the config baseline is not applied while it runs
 * (evaluate-path), so an accepted edit would report "applied" for a change with no
 * effect until the Run ended.
 *
 * The kill switch is NEVER locked and the Worker never freezes `enabled`: an
 * operator must always be able to turn a Flag off in an incident.
 */
export function isLocked(view: FlagDetailView, group: FlagDetailFieldGroup): boolean {
  if (group === "kill-switch") return false;
  return view.controllingExperiment !== null;
}

function availabilityOf(
  variant: Variant,
  unconfigured: boolean,
  narrowed: boolean,
  available: string[],
): VariantAvailability {
  if (unconfigured) return "unavailable";
  if (!narrowed) return "not-narrowed";
  return available.includes(variant.name) ? "available" : "unavailable";
}

function variantName(catalog: Variant[], variantId: string): string {
  return catalog.find((variant) => variant.id === variantId)?.name ?? variantId;
}
