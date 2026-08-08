import type { OrganizationUsageResponse } from "@splitch/contracts";
import type { OrgRole } from "./session";

/** The highest-consuming rows shown per dimension; the rest are stated, not hidden. */
const ROW_LIMIT = 10;

interface UsageRow {
  readonly key: string;
  readonly label: string;
  readonly evaluations: number;
}

export interface UsageDimension {
  readonly id: string;
  readonly label: string;
  /** Rows kept for display, worst-first. */
  readonly rows: readonly UsageRow[];
  /** How many rows the dimension actually has, so truncation can be stated. */
  readonly totalRows: number;
}

interface UsagePeriod {
  readonly month: string;
  readonly startsAt: string;
  readonly endsAt: string;
}

/**
 * Either the month's Evaluation consumption, or the reason it could not be read.
 * There is no third "assume zero" shape: a failed read that renders as an empty
 * month is exactly the disguised failure ADR-0036 forbids, and here it would
 * also understate a bill.
 */
export type OrgUsage =
  | {
      readonly kind: "ready";
      readonly period: UsagePeriod;
      readonly evaluations: number;
      readonly dimensions: readonly UsageDimension[];
    }
  | { readonly kind: "unavailable"; readonly message: string };

export interface OrgBillingView {
  readonly orgSlug: string;
  readonly orgRole: OrgRole;
  readonly plan: string;
  /** True when the `stripe_*` seam carries ids, which only an account team sets today. */
  readonly hasBillingAccount: boolean;
  readonly usage: OrgUsage;
}

/**
 * Org role matrix: managing the plan and payment method is owner-only. The panel
 * renders the locked affordance; the Control Plane Worker is the guardian
 * (ADR-0023), so this gate is presentation only.
 */
export function canManageBilling(role: OrgRole): boolean {
  return role === "owner";
}

const PLAN_LABELS: Record<string, string> = {
  free: "Free",
  pro: "Pro",
  enterprise: "Enterprise",
};

/** An unrecognised plan is a data fault, not a display case: name it loudly. */
export function planLabel(plan: string): string {
  const label = PLAN_LABELS[plan];
  if (!label) throw new Error(`unknown Organization plan: ${plan}`);
  return label;
}

const MONTH_FORMAT = new Intl.DateTimeFormat("en-US", {
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});

/** `2026-08` → `August 2026`. The period is UTC, so the label is formatted in UTC. */
export function formatUsageMonth(month: string): string {
  const match = month.match(/^(\d{4})-(\d{2})$/);
  if (!match) throw new Error(`unusable usage period: ${month}`);
  return MONTH_FORMAT.format(new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1)));
}

const COUNT_FORMAT = new Intl.NumberFormat("en-US");

export function formatEvaluations(evaluations: number): string {
  return COUNT_FORMAT.format(evaluations);
}

/**
 * A row's share of the month, always against the month's own total — never
 * against the largest row on screen. A bar that rebased per dimension would make
 * a 2% slice look like the whole month.
 */
export function usageShare(evaluations: number, monthEvaluations: number): number {
  if (monthEvaluations <= 0) {
    throw new Error("a usage share needs a positive month total");
  }
  return evaluations / monthEvaluations;
}

export interface UsageNames {
  readonly apps: ReadonlyMap<string, string>;
  readonly environments: ReadonlyMap<string, string>;
}

type Counted = { readonly key: string; readonly evaluations: number };

/**
 * Rows keyed by a resource that can be deleted. Consumption billed against a
 * since-deleted resource is still consumption, so it is summed into one stated
 * row rather than dropped — dropping it would make the dimensions disagree with
 * the month total.
 */
function resolvedDimension(
  id: string,
  label: string,
  entries: readonly Counted[],
  resolve: (key: string) => string | null,
  missingLabel: string,
): UsageDimension {
  const named: UsageRow[] = [];
  let missing = 0;
  for (const entry of entries) {
    const resolved = resolve(entry.key);
    if (resolved === null) {
      missing += entry.evaluations;
      continue;
    }
    named.push({ key: entry.key, label: resolved, evaluations: entry.evaluations });
  }
  named.sort((a, b) => b.evaluations - a.evaluations || a.label.localeCompare(b.label));

  const rows = named.slice(0, ROW_LIMIT);
  if (missing > 0) rows.push({ key: "__unresolved__", label: missingLabel, evaluations: missing });
  return { id, label, rows, totalRows: named.length + (missing > 0 ? 1 : 0) };
}

/**
 * Rows over a closed set of values. A value the query returned no group for was
 * genuinely not consumed this month, so it renders as an explicit zero: an
 * absent row would read as "unknown" for a quantity that is known.
 */
function fixedDimension(
  id: string,
  label: string,
  entries: readonly Counted[],
  order: readonly (readonly [string, string])[],
): UsageDimension {
  const rows = order.map(([key, rowLabel]) => ({
    key,
    label: rowLabel,
    evaluations: entries.find((entry) => entry.key === key)?.evaluations ?? 0,
  }));
  return { id, label, rows, totalRows: rows.length };
}

/** A key that is already user-facing copy labels itself; a blank one names nothing. */
function identityLabel(key: string): string | null {
  return key.trim() === "" ? null : key;
}

/**
 * The ADR-0033 reporting dimensions, in the order the ADR names them. They are
 * one breakdown of one number, not seven separate meters.
 */
export function toUsageDimensions(
  breakdown: OrganizationUsageResponse["breakdown"],
  names: UsageNames,
): readonly UsageDimension[] {
  return [
    resolvedDimension(
      "app",
      "By App",
      breakdown.byApp.map((row) => ({ key: row.appId, evaluations: row.evaluations })),
      (key) => names.apps.get(key) ?? null,
      "Apps no longer in this Organization",
    ),
    resolvedDimension(
      "environment",
      "By Environment",
      breakdown.byEnvironment.map((row) => ({
        key: row.environmentId,
        evaluations: row.evaluations,
      })),
      (key) => names.environments.get(key) ?? null,
      "Environments that have been deleted",
    ),
    resolvedDimension(
      "flag",
      "By Flag",
      breakdown.byFlag.map((row) => ({ key: row.flagKey, evaluations: row.evaluations })),
      identityLabel,
      "Evaluations that named no Flag",
    ),
    resolvedDimension(
      "sdk-runtime",
      "By SDK runtime",
      breakdown.bySdkRuntime.map((row) => ({ key: row.sdkRuntime, evaluations: row.evaluations })),
      identityLabel,
      "Runtimes that did not identify themselves",
    ),
    fixedDimension(
      "batch",
      "Single vs batch",
      breakdown.byBatch.map((row) => ({ key: row.mode, evaluations: row.evaluations })),
      [
        ["single", "Single"],
        ["batch", "Batched"],
      ],
    ),
    fixedDimension(
      "source",
      "Remote vs cached",
      breakdown.bySource.map((row) => ({ key: row.source, evaluations: row.evaluations })),
      [
        ["remote", "Remote"],
        ["cached", "Cached"],
      ],
    ),
    fixedDimension(
      "exposure",
      "Exposure-bearing",
      breakdown.byExposure.map((row) => ({ key: row.exposure, evaluations: row.evaluations })),
      [
        ["bearing", "Carried an Exposure"],
        ["not_bearing", "No Exposure"],
      ],
    ),
  ];
}
