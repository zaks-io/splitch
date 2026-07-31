import type { FlagDetailView } from "./flag-detail-view";
import {
  availableNames,
  catalogNames,
  type PromotionRow,
  ruleServing,
  ruleVariantNames,
} from "./promotion-diff";

/**
 * The ticked rows, and the one function that turns them into the promote
 * endpoint's `select`.
 *
 * `promotionSelect` takes the ROWS the screen renders as ticked, not a selection
 * id set, so the diff on screen and the payload on the wire cannot drift: there is
 * no second traversal that could include a row the operator never saw, or drop one
 * they did (the ticket's invariant).
 */

export type PromotionSelect = {
  readonly availability?: readonly string[];
  readonly targeting?: true;
  readonly rollout?: true;
  readonly enabled?: true;
};

/** The ticked rows, in the order the screen renders them. */
export function selectedRows(
  rows: readonly PromotionRow[],
  selected: ReadonlySet<string>,
): readonly PromotionRow[] {
  return rows.filter((row) => selected.has(row.id));
}

/**
 * Absence is the contract: a field group the operator did not tick is OMITTED so
 * the Worker leaves the target's own value untouched. Sending `targeting: false`
 * or an empty availability array would be a different request — an explicit
 * instruction to promote nothing, which `.strict()` on the endpoint would take at
 * face value.
 */
export function promotionSelect(rows: readonly PromotionRow[]): PromotionSelect {
  const availability = rows
    .filter((row) => row.kind === "availability")
    .map((row) => row.variantName)
    .filter((name): name is string => name !== null);

  return {
    ...(availability.length > 0 ? { availability } : {}),
    ...(rows.some((row) => row.kind === "targeting") ? { targeting: true as const } : {}),
    ...(rows.some((row) => row.kind === "rollout") ? { rollout: true as const } : {}),
    ...(rows.some((row) => row.kind === "enabled") ? { enabled: true as const } : {}),
  };
}

/** "Promote whole config": every row the diff found, and nothing invented. */
export function wholeConfigSelection(rows: readonly PromotionRow[]): Set<string> {
  return new Set(rows.map((row) => row.id));
}

/** "Promote this Variant": exactly one availability row, the one act that is per-item. */
export function variantSelection(rows: readonly PromotionRow[], variantName: string): Set<string> {
  return new Set(rows.filter((row) => row.variantName === variantName).map((row) => row.id));
}

/** "Availability only": every availability row, no targeting, rollout, or enabled. */
export function availabilityOnlySelection(rows: readonly PromotionRow[]): Set<string> {
  return new Set(rows.filter((row) => row.kind === "availability").map((row) => row.id));
}

export type PromotionDependency = {
  /** The Variant a promoted Targeting Rule would serve but could not reach. */
  readonly variantName: string;
  /** The rule that needs it, rendered, so the nudge can say why. */
  readonly reason: string;
  /**
   * `tick` and `untick` name a row the operator can act on. `none` means no row
   * would fix it — the Variant is unavailable in BOTH Environments — so the panel
   * says the Worker will refuse rather than offering a button that cannot help.
   */
  readonly remedy: "tick" | "untick" | "none";
  readonly rowId: string | null;
};

/**
 * The dangling-reference check, computed exactly the way the Worker computes it.
 *
 * Offer in the panel, block at the Worker (ADR-0028/0036). This is the offer, and
 * it is deliberately derived from the same inputs and the same rule as
 * `preparePromotion` → `missingRuleVariantNames`: a nudge that disagreed with the
 * enforcement would either nag about a promotion that succeeds or stay silent on
 * one that gets rejected. Ticking the offered row is never automatic — a silent
 * side effect on availability is the thing this screen exists to prevent.
 */
export function promotionDependencies(
  rows: readonly PromotionRow[],
  selected: ReadonlySet<string>,
  source: FlagDetailView,
  target: FlagDetailView,
): readonly PromotionDependency[] {
  const ticked = selectedRows(rows, selected);
  const promotesTargeting = ticked.some((row) => row.kind === "targeting");
  const landed = new Set(landedAvailability(ticked, source, target));
  const servingView = promotesTargeting ? source : target;

  return ruleVariantNames(servingView)
    .filter((name) => !landed.has(name))
    .map((name) => dependency(name, rows, selected, servingView));
}

/**
 * The target's available Variant list AFTER this selection lands — the same
 * copy-selected-names-across walk the Worker does, including the deletion side:
 * ticking a Variant the source does not serve REMOVES it from the target.
 */
export function landedAvailability(
  ticked: readonly PromotionRow[],
  source: FlagDetailView,
  target: FlagDetailView,
): string[] {
  const next = new Set(availableNames(target));
  const sourceAvailable = new Set(availableNames(source));
  for (const row of ticked) {
    if (row.kind !== "availability" || row.variantName === null) continue;
    if (sourceAvailable.has(row.variantName)) next.add(row.variantName);
    else next.delete(row.variantName);
  }
  return catalogNames(target).filter((name) => next.has(name));
}

function dependency(
  variantName: string,
  rows: readonly PromotionRow[],
  selected: ReadonlySet<string>,
  servingView: FlagDetailView,
): PromotionDependency {
  const row = rows.find((candidate) => candidate.variantName === variantName);
  const renderedRule = ruleServing(servingView, variantName);
  const reason = renderedRule
    ? `Targeting Rule ${renderedRule.replace(/^(\d+)\. /, "$1: ")}`
    : `a Targeting Rule serving ${variantName}`;

  if (!row) return { variantName, reason, remedy: "none", rowId: null };
  return {
    variantName,
    reason,
    remedy: selected.has(row.id) ? "untick" : "tick",
    rowId: row.id,
  };
}

/**
 * The operator's own words above the Worker's diff in the confirm gate. It names
 * the field groups by the same labels the rows carry, so the gate and the screen
 * behind it describe one proposal.
 */
export function promotionSummary(
  rows: readonly PromotionRow[],
  sourceEnv: string,
  targetEnv: string,
): string {
  const availability = rows.filter((row) => row.kind === "availability");
  const parts: string[] = [];
  if (availability.length > 0) {
    parts.push(`availability for ${availability.map((row) => row.label).join(", ")}`);
  }
  if (rows.some((row) => row.kind === "targeting")) parts.push("all Targeting Rules");
  if (rows.some((row) => row.kind === "rollout")) parts.push("the baseline rollout");
  if (rows.some((row) => row.kind === "enabled")) parts.push("the kill switch");

  return `Promote ${listed(parts)} from ${sourceEnv} into ${targetEnv}`;
}

function listed(parts: readonly string[]): string {
  if (parts.length === 0) return "nothing";
  if (parts.length === 1) return parts[0] as string;
  return `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}
