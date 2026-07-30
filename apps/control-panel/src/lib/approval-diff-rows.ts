import type { ApprovalDiff, ApprovalDiffEntry } from "@splitch/contracts";

/**
 * The Worker's canonical Approval diff, turned into rows a human can read under
 * time pressure.
 *
 * Deliberately generic: it consumes an `ApprovalDiff` and an optional id -> name
 * map, and knows nothing about Flag editing. Promotion between Environments
 * (SPL-122) produces the same diff shape from the same contract and renders
 * through these rows unchanged.
 *
 * Nothing is dropped. An entry this module has no field mapping for still becomes
 * a row, under `Other`, carrying its raw JSON Pointer — an unmapped change the
 * operator never sees is a change they approved blind.
 */

export type ApprovalDiffRow = {
  readonly path: string;
  readonly group: string;
  readonly field: string;
  /** Rendered lines. Empty means the value was absent, not that it was empty. */
  readonly before: readonly string[];
  readonly after: readonly string[];
  /** `false` when the value did not exist on that side (an add or a remove). */
  readonly hasBefore: boolean;
  readonly hasAfter: boolean;
};

/** Human name for a resource id the diff refers to (Variant id -> Variant name). */
export type ApprovalDiffLabels = Readonly<Record<string, string>>;

const GROUP_ORDER = [
  "Kill switch",
  "Available Variants",
  "Targeting Rules",
  "Baseline rollout",
  "Other",
] as const;

type FieldMapping = { readonly group: string; readonly field: string };

const FIELD_MAPPINGS: ReadonlyArray<readonly [RegExp, FieldMapping]> = [
  [/^\/enabled$/, { group: "Kill switch", field: "Serving state" }],
  [
    /^\/availableVariantNames$/,
    { group: "Available Variants", field: "Available in this Environment" },
  ],
  [/^\/targetingRules/, { group: "Targeting Rules", field: "Rule list" }],
  [/^\/rollout$/, { group: "Baseline rollout", field: "Baseline percentage" }],
  [/^\/rollout\/percentage$/, { group: "Baseline rollout", field: "Baseline percentage" }],
  [/^\/rollout\/salt$/, { group: "Baseline rollout", field: "Bucketing salt" }],
];

export function approvalDiffRows(
  diff: ApprovalDiff,
  labels: ApprovalDiffLabels = {},
): ApprovalDiffRow[] {
  return diff.entries
    .map((entry) => toRow(entry, labels))
    .sort((left, right) => groupRank(left.group) - groupRank(right.group));
}

/** The groups present in these rows, in the order the gate should render them. */
export function approvalDiffGroups(rows: readonly ApprovalDiffRow[]): string[] {
  return [...new Set(rows.map((row) => row.group))].sort((a, b) => groupRank(a) - groupRank(b));
}

function groupRank(group: string): number {
  const index = (GROUP_ORDER as readonly string[]).indexOf(group);
  return index === -1 ? GROUP_ORDER.length : index;
}

function toRow(entry: ApprovalDiffEntry, labels: ApprovalDiffLabels): ApprovalDiffRow {
  const mapping = FIELD_MAPPINGS.find(([pattern]) => pattern.test(entry.path))?.[1] ?? {
    group: "Other",
    field: entry.path,
  };
  const hasBefore = entry.operation !== "add";
  const hasAfter = entry.operation !== "remove";
  return {
    path: entry.path,
    group: mapping.group,
    field: mapping.field,
    before: hasBefore
      ? renderValue(entry.path, (entry as { current: unknown }).current, labels)
      : [],
    after: hasAfter
      ? renderValue(entry.path, (entry as { proposed: unknown }).proposed, labels)
      : [],
    hasBefore,
    hasAfter,
  };
}

/**
 * One value, rendered as lines rather than a JSON blob. A raw dump is technically
 * complete and practically unreadable, which is the same as not showing it during
 * an incident.
 */
function renderValue(path: string, value: unknown, labels: ApprovalDiffLabels): string[] {
  if (path === "/enabled") return [value === true ? "Enabled" : "Disabled"];
  if (path === "/availableVariantNames") return renderAvailability(value);
  if (path.startsWith("/targetingRules")) return renderTargetingRules(value, labels);
  if (path === "/rollout") return renderRollout(value);
  if (path === "/rollout/percentage") return [`${String(value)}%`];
  return renderScalar(value);
}

function renderAvailability(value: unknown): string[] {
  if (!Array.isArray(value)) return renderScalar(value);
  // An empty availability list means "never narrowed", so the whole catalog is a
  // candidate. Printing it as "none" would claim the opposite of what is served.
  if (value.length === 0) return ["Not narrowed — every catalog Variant is a candidate"];
  return value.map(String);
}

function renderRollout(value: unknown): string[] {
  if (value === null || value === undefined) return ["No baseline rollout"];
  if (isRecord(value) && typeof value.percentage === "number") {
    // The salt is never shown: it is server-minted, the operator cannot set it,
    // and printing it invites someone to think they should.
    return [`${value.percentage}% of traffic`];
  }
  return renderScalar(value);
}

function renderTargetingRules(value: unknown, labels: ApprovalDiffLabels): string[] {
  if (!Array.isArray(value)) return renderScalar(value);
  if (value.length === 0) return ["No Targeting Rules"];
  return value.map((rule, index) =>
    isRecord(rule) ? renderRule(rule, labels) : `#${index + 1} ${renderScalar(rule).join(" ")}`,
  );
}

function renderRule(rule: Record<string, unknown>, labels: ApprovalDiffLabels): string {
  const variantId = typeof rule.variantId === "string" ? rule.variantId : "unknown Variant";
  const serves = labels[variantId] ?? variantId;
  const conditions = Array.isArray(rule.conditions) ? rule.conditions : [];
  const clause = conditions
    .map((condition) =>
      isRecord(condition)
        ? `${String(condition.attribute)} ${String(condition.operator)} ${JSON.stringify(condition.value)}`
        : String(condition),
    )
    .join(" AND ");
  const rollout =
    isRecord(rule.percentageRollout) && typeof rule.percentageRollout.percentage === "number"
      ? ` at ${rule.percentageRollout.percentage}%`
      : "";
  return `priority ${String(rule.priority ?? "?")}: ${clause || "no conditions"} → serves ${serves}${rollout}`;
}

function renderScalar(value: unknown): string[] {
  if (value === null) return ["None"];
  if (value === undefined) return [];
  if (typeof value === "string") return [value];
  return [JSON.stringify(value) ?? String(value)];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
