import {
  FlagListResponseSchema,
  FlagResponseSchema,
  HydratedFlagListResponseSchema,
  type HydratedFlagResponse,
  HydratedFlagResponseSchema,
  HydratedPrincipalFlagListResponseSchema,
} from "@splitch/sdk/control-plane";
import { SplitchCliError } from "./errors.js";
import { cellValue, formatTable, truncationNotice } from "./format-payload.js";

export function formatFlagRead(operationId: string, payload: unknown, summary: boolean): string {
  if (summary) {
    return formatFlagSummary(operationId, payload);
  }
  if (operationId === "flags_list") {
    const parsed = HydratedFlagListResponseSchema.safeParse(payload);
    if (!parsed.success) throw flagReadContractError(operationId, "hydrated");
    if (parsed.data.items.length === 0) return withListBound(EMPTY_CATALOG, parsed.data);
    return withListBound(parsed.data.items.map(formatHydratedFlag).join("\n\n"), parsed.data);
  }
  const parsed = HydratedFlagResponseSchema.safeParse(payload);
  if (!parsed.success) throw flagReadContractError(operationId, "hydrated");
  return formatHydratedFlag(parsed.data);
}

function formatFlagSummary(operationId: string, payload: unknown): string {
  const parsed =
    operationId === "flags_list"
      ? FlagListResponseSchema.safeParse(payload)
      : FlagResponseSchema.safeParse(payload);
  if (!parsed.success) throw flagReadContractError(operationId, "summary");
  if (operationId !== "flags_list") return formatFlagSummaryList([parsed.data as SummaryFlag]);
  const list = parsed.data as ListBound & { items: SummaryFlag[] };
  if (list.items.length === 0) return withListBound(EMPTY_CATALOG, list);
  return withListBound(formatFlagSummaryList(list.items), list);
}

const EMPTY_CATALOG = "No Flags found.";

interface ListBound {
  readonly readLimit: number;
  readonly readTruncated: boolean;
}

/**
 * The Flag catalog read is bounded and is not paginable, so `readTruncated` is
 * the only signal that `items` is a page rather than the catalog. `--json`
 * carries it in the envelope; human output has to say it out loud or an
 * operator reads a truncated list as complete.
 */
function withListBound(rendered: string, list: ListBound): string {
  if (!list.readTruncated) return rendered;
  return `${rendered}\n\n${truncationNotice(list.readLimit, "Flags")}`;
}

export function assertHydratedFlagRead(operationId: string, payload: unknown): void {
  const parsed =
    operationId === "flags_list"
      ? HydratedFlagListResponseSchema.safeParse(payload)
      : HydratedFlagResponseSchema.safeParse(payload);
  if (!parsed.success) throw flagReadContractError(operationId, "hydrated");
}

/** The principal-wide read carries the same SPL-529 hydration contract as `flags_list`. */
export function assertHydratedPrincipalFlagRead(payload: unknown): void {
  const parsed = HydratedPrincipalFlagListResponseSchema.safeParse(payload);
  if (!parsed.success) throw flagReadContractError("principal_flags_list", "hydrated");
}

function flagReadContractError(operationId: string, mode: "summary" | "hydrated"): SplitchCliError {
  return new SplitchCliError({
    code: "INTERNAL_SERVER_ERROR",
    causeSummary:
      mode === "hydrated"
        ? `${operationId} requested complete Flag Configurations, but the server returned an unhydrated response`
        : `${operationId} requested a compact Flag summary, but the server returned an out-of-contract response`,
    remediation:
      "Update the server to the SPL-529 Flag-read contract or report the response mismatch",
  });
}

function formatFlagSummaryList(flags: readonly SummaryFlag[]): string {
  if (!flags.some((flag) => flag.flagConfiguration !== undefined)) {
    return formatTable(
      ["ID", "KEY", "NAME"],
      flags.map((flag) => [flag.id, flag.key, flag.name]),
    );
  }
  return formatTable(
    ["ID", "KEY", "NAME", "ENABLED", "ROLLOUT", "DEFAULT VARIANT"],
    flags.map((flag) => [
      flag.id,
      flag.key,
      flag.name,
      cellValue(flag.flagConfiguration?.enabled),
      cellValue(flag.flagConfiguration?.rollout),
      cellValue(flag.flagConfiguration?.defaultVariant),
    ]),
  );
}

function formatHydratedFlag(flag: HydratedFlagResponse): string {
  const definition = [
    `Flag: ${flag.name}`,
    `ID: ${flag.id}`,
    `App: ${flag.appId}`,
    `Key: ${flag.key}`,
    ...(flag.description === undefined ? [] : [`Description: ${flag.description}`]),
    // The Flag schema is a JSON Schema document, so its compact JSON is the
    // value rather than a stand-in for one.
    `Schema: ${flag.schema === null ? "(none)" : JSON.stringify(flag.schema)}`,
    `Default Variant ID: ${flag.defaultVariantId}`,
    `Created: ${flag.createdAt}`,
    `Updated: ${flag.updatedAt}`,
  ];
  const variants = formatTable(
    ["VARIANT ID", "NAME", "VALUE", "DESCRIPTION"],
    flag.variants.map((variant) => [
      variant.id,
      variant.name,
      cellValue(variant.value),
      cellValue(variant.description),
    ]),
  );
  const configurations = flag.configurations.map(formatConfiguration).join("\n\n");
  return [...definition, "", "Variants", variants, "", "Configurations", configurations].join("\n");
}

function formatConfiguration(
  configuration: HydratedFlagResponse["configurations"][number],
): string {
  return [
    `Environment: ${configuration.environmentId}`,
    `Enabled: ${configuration.enabled}`,
    `Available Variants: ${nameList(configuration.availableVariantNames)}`,
    `Rollout: ${formatRollout(configuration.rollout)}`,
    `Experiment: ${formatExperimentRef(configuration.experiment)}`,
    ...formatTargetingRules(configuration.targetingRules),
  ].join("\n");
}

/**
 * A bare header row over no rows reads as a rendering failure, so an
 * Environment with no rules says so on the label line instead.
 */
function formatTargetingRules(
  rules: HydratedFlagResponse["configurations"][number]["targetingRules"],
): string[] {
  if (rules.length === 0) return ["Targeting Rules: (none)"];
  return [
    "Targeting Rules",
    formatTable(
      ["RULE ID", "PRIORITY", "CONDITIONS", "VARIANT ID", "SEGMENT ID", "ROLLOUT"],
      rules.map((rule) => [
        rule.id,
        cellValue(rule.priority),
        // Conditions are a predicate tree; their JSON is the readable form.
        cellValue(rule.conditions),
        rule.variantId,
        cellValue(rule.segmentId),
        cellValue(rule.percentageRollout),
      ]),
    ),
  ];
}

function nameList(names: readonly string[]): string {
  return names.length === 0 ? "(none)" : names.join(", ");
}

function formatRollout(rollout: { percentage: number; salt: string } | null): string {
  return rollout === null ? "(none)" : `${rollout.percentage}% (salt ${rollout.salt})`;
}

function formatExperimentRef(experiment: { id: string; key: string } | null): string {
  return experiment === null ? "(none)" : `${experiment.key} (${experiment.id})`;
}

interface SummaryFlag {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly flagConfiguration?: {
    readonly enabled: boolean;
    readonly rollout: number | null;
    readonly defaultVariant: string;
  };
}
