import type { FlagDetailView } from "./flag-detail-view";

/**
 * One proposed change to a Flag Configuration, named in the operator's words.
 *
 * `summary` is what the confirm gate puts above the diff: it says what was asked
 * for, while the diff below says what the Worker computed. Keeping them separate
 * is the point — if they disagree, the operator can see it.
 */
export type FlagEditIntent =
  | { readonly kind: "config"; readonly summary: string; readonly patch: FlagConfigChange }
  | { readonly kind: "targeting"; readonly summary: string; readonly edit: TargetingEdit };

type FlagConfigChange = {
  readonly enabled?: boolean;
  readonly availableVariantNames?: readonly string[];
  readonly rollout?: { readonly percentage: number } | null;
};

/**
 * A Targeting change is expressed as an operation, not as a rule list.
 *
 * The replace endpoint takes the whole list, but the list is assembled from the
 * Worker's own current Configuration inside the server function. The browser never
 * holds raw rules, so it can neither round-trip a stale list nor restate a
 * bucketing salt it has no business knowing.
 */
type TargetingEdit =
  | { readonly kind: "remove"; readonly ruleId: string }
  | {
      readonly kind: "add";
      readonly ruleId: string;
      readonly attribute: string;
      readonly operator: "eq";
      readonly value: string;
      readonly variantId: string;
    };

export function killSwitchIntent(enabled: boolean): FlagEditIntent {
  return {
    kind: "config",
    summary: enabled ? "Enable this Flag in this Environment" : "Turn this Flag off immediately",
    patch: { enabled },
  };
}

export function baselineRolloutIntent(percentage: number | null): FlagEditIntent {
  return {
    kind: "config",
    summary:
      percentage === null
        ? "Clear the baseline rollout"
        : `Set the baseline rollout to ${percentage}%`,
    patch: { rollout: percentage === null ? null : { percentage } },
  };
}

/**
 * Availability is expressed as the FULL proposed set, never as a delta: the
 * contract field is the whole list, and a delta would make the panel responsible
 * for merging against a config it read a moment ago.
 */
export function availabilityIntent(
  view: FlagDetailView,
  variantName: string,
  available: boolean,
): FlagEditIntent {
  const current = availableVariantNames(view);
  const next = available
    ? [...current, variantName].filter(unique)
    : current.filter((name) => name !== variantName);
  return {
    kind: "config",
    summary: available
      ? `Make Variant ${variantName} available in ${view.env}`
      : `Remove Variant ${variantName} from ${view.env}`,
    patch: { availableVariantNames: next },
  };
}

export function removeTargetingRuleIntent(ruleId: string): FlagEditIntent {
  return {
    kind: "targeting",
    summary: "Remove a Targeting Rule",
    edit: { kind: "remove", ruleId },
  };
}

/**
 * Appends a rule that serves one Variant to everyone matching one condition.
 *
 * No percentage rollout on a NEW rule: a rule-level rollout carries a bucketing
 * salt, the salt is server-minted for the baseline and has no minting path here
 * yet, and inventing one in the browser would silently choose who gets bucketed.
 * An honest "all matches" rule beats a fabricated salt (SPL-232).
 */
export function addTargetingRuleIntent(
  draft: { attribute: string; value: string; variantId: string },
  ruleId: string,
): FlagEditIntent {
  return {
    kind: "targeting",
    summary: "Add a Targeting Rule",
    edit: {
      kind: "add",
      ruleId,
      attribute: draft.attribute,
      operator: "eq",
      value: draft.value,
      variantId: draft.variantId,
    },
  };
}

function availableVariantNames(view: FlagDetailView): string[] {
  return view.catalog.filter((variant) => variant.availability === "available").map((v) => v.name);
}

function unique<T>(value: T, index: number, all: T[]): boolean {
  return all.indexOf(value) === index;
}
