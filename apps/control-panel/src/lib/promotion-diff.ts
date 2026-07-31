import type { FlagDetailView } from "./flag-detail-view";

/**
 * The side-by-side Promotion diff, as rows at exactly the granularity the promote
 * endpoint accepts (ADR-0028 `select`).
 *
 * The row set IS the selection vocabulary. There is deliberately no row a caller
 * could tick that `select` cannot express, and no `select` field without a row:
 * one row per Variant's availability, ONE atomic row for the whole Targeting Rule
 * list, one for the baseline rollout, one for the enabled state. Per-rule rows are
 * therefore not "not implemented yet" — they are structurally absent, because
 * Targeting is ordered and first-match-wins, so a promoted subset would produce a
 * list that behaves like neither Environment (screen-inventory.md).
 */

type PromotionRowKind = "availability" | "targeting" | "rollout" | "enabled";

export type PromotionRow = {
  /** Stable selection address. Availability rows are `availability:<variantName>`. */
  readonly id: string;
  readonly kind: PromotionRowKind;
  /** The `select.availability` entry this row promotes, or null for the other kinds. */
  readonly variantName: string | null;
  readonly label: string;
  /** What promoting this row does to the target, as a marker on the row. */
  readonly effect: "add" | "remove" | "replace";
  /** The target Environment's current value, one rendered line per entry. */
  readonly target: readonly string[];
  /** The source Environment's value, one rendered line per entry. */
  readonly source: readonly string[];
};

export type PromotionDiff = {
  /** Only rows that actually differ: a tickable no-op is a lie about the payload. */
  readonly rows: readonly PromotionRow[];
  /** Field groups read and found identical, so the screen can say so explicitly. */
  readonly identical: readonly PromotionRowKind[];
  /**
   * The source has never narrowed its Variant availability, so its available list
   * is empty and promoting an availability row REMOVES that Variant from the
   * target. Surfaced because the mechanical truth reads backwards from the intent.
   */
  readonly sourceAvailabilityNotNarrowed: boolean;
};

export function promotionDiff(source: FlagDetailView, target: FlagDetailView): PromotionDiff {
  const rows: PromotionRow[] = [];
  const identical: PromotionRowKind[] = [];

  for (const row of availabilityRows(source, target)) rows.push(row);
  if (!rows.some((row) => row.kind === "availability")) identical.push("availability");

  const targetingChanged = !sameLines(ruleLines(target), ruleLines(source));
  if (targetingChanged) {
    rows.push({
      id: "targeting",
      kind: "targeting",
      variantName: null,
      label: "All Targeting Rules",
      effect: "replace",
      target: ruleLines(target),
      source: ruleLines(source),
    });
  } else {
    identical.push("targeting");
  }

  if (target.baselineRolloutPercentage !== source.baselineRolloutPercentage) {
    rows.push({
      id: "rollout",
      kind: "rollout",
      variantName: null,
      label: "Baseline rollout",
      effect: "replace",
      target: [rolloutLine(target.baselineRolloutPercentage)],
      source: [rolloutLine(source.baselineRolloutPercentage)],
    });
  } else {
    identical.push("rollout");
  }

  if (target.enabled !== source.enabled) {
    rows.push({
      id: "enabled",
      kind: "enabled",
      variantName: null,
      label: "Kill switch",
      effect: "replace",
      target: [enabledLine(target.enabled)],
      source: [enabledLine(source.enabled)],
    });
  } else {
    identical.push("enabled");
  }

  return {
    rows,
    identical,
    sourceAvailabilityNotNarrowed: !source.availabilityNarrowed,
  };
}

export function availableNames(view: FlagDetailView): string[] {
  return view.catalog.filter((variant) => variant.availability === "available").map((v) => v.name);
}

/** Catalog order, so a promoted list reads the same way the Worker writes it. */
export function catalogNames(view: FlagDetailView): string[] {
  return view.catalog.map((variant) => variant.name);
}

/**
 * The Targeting Rule list rendered as ordered lines.
 *
 * Rule ids are excluded on purpose: promotion mints fresh ids for the copied
 * rules, so comparing them would report every list as different forever. What the
 * operator is promoting is the ordered behaviour, and that is what is compared.
 */
function ruleLines(view: FlagDetailView): string[] {
  return view.targetingRules.map((rule, index) => {
    const conditions = rule.conditions
      .map((condition) => `${condition.attribute} ${condition.operator} ${condition.value}`)
      .join(" and ");
    const percentage = rule.rolloutPercentage === null ? "" : ` (${rule.rolloutPercentage}%)`;
    return `${index + 1}. ${conditions} → ${rule.variantName}${percentage}`;
  });
}

/** Names of Variants the source's Targeting Rules serve, in first-match order. */
export function ruleVariantNames(view: FlagDetailView): string[] {
  return [...new Set(view.targetingRules.map((rule) => rule.variantName))];
}

/** The rule that first explains why a Variant must be available, for the nudge label. */
export function ruleServing(view: FlagDetailView, variantName: string): string | null {
  const index = view.targetingRules.findIndex((rule) => rule.variantName === variantName);
  return index === -1 ? null : (ruleLines(view)[index] ?? null);
}

function availabilityRows(source: FlagDetailView, target: FlagDetailView): PromotionRow[] {
  const sourceAvailable = new Set(availableNames(source));
  const targetAvailable = new Set(availableNames(target));

  return target.catalog
    .filter((variant) => sourceAvailable.has(variant.name) !== targetAvailable.has(variant.name))
    .map((variant) => ({
      id: `availability:${variant.name}`,
      kind: "availability" as const,
      variantName: variant.name,
      label: variant.name,
      effect: sourceAvailable.has(variant.name) ? ("add" as const) : ("remove" as const),
      target: [availabilityLine(targetAvailable.has(variant.name), target.availabilityNarrowed)],
      source: [availabilityLine(sourceAvailable.has(variant.name), source.availabilityNarrowed)],
    }));
}

/**
 * Three states, never two. An un-narrowed Configuration has an EMPTY available
 * list because it was never narrowed, which makes the whole catalog a candidate —
 * the opposite of "nothing can serve here" (flag-editing-ux.md).
 */
function availabilityLine(available: boolean, narrowed: boolean): string {
  if (available) return "Available";
  return narrowed ? "Not available" : "Not narrowed — whole catalog is a candidate";
}

function rolloutLine(percentage: number | null): string {
  return percentage === null ? "No baseline rollout" : `${percentage}% of traffic`;
}

function enabledLine(enabled: boolean): string {
  return enabled ? "On" : "Off";
}

function sameLines(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((line, index) => line === right[index]);
}
