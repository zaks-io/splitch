import {
  FlagListResponseSchema,
  FlagResponseSchema,
  HydratedFlagListResponseSchema,
  HydratedFlagResponseSchema,
  type HydratedFlagResponse,
} from "@splitch/sdk/control-plane";
import { SplitchCliError } from "./errors.js";

export function formatFlagRead(operationId: string, payload: unknown, summary: boolean): string {
  if (summary) {
    return operationId === "flags_list"
      ? formatFlagSummaryList(FlagListResponseSchema.parse(payload).items)
      : formatFlagSummaryList([FlagResponseSchema.parse(payload)]);
  }
  if (operationId === "flags_list") {
    const parsed = HydratedFlagListResponseSchema.safeParse(payload);
    if (!parsed.success) throw missingHydrationError(operationId);
    return parsed.data.items.map(formatHydratedFlag).join("\n\n");
  }
  const parsed = HydratedFlagResponseSchema.safeParse(payload);
  if (!parsed.success) throw missingHydrationError(operationId);
  return formatHydratedFlag(parsed.data);
}

export function assertHydratedFlagRead(operationId: string, payload: unknown): void {
  const parsed =
    operationId === "flags_list"
      ? HydratedFlagListResponseSchema.safeParse(payload)
      : HydratedFlagResponseSchema.safeParse(payload);
  if (!parsed.success) throw missingHydrationError(operationId);
}

function missingHydrationError(operationId: string): SplitchCliError {
  return new SplitchCliError({
    code: "CLI_UNEXPECTED_ERROR",
    causeSummary: `${operationId} requested complete Flag Configurations, but the server returned an unhydrated response`,
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
      reported(flag.flagConfiguration?.enabled),
      reported(flag.flagConfiguration?.rollout),
      reported(flag.flagConfiguration?.defaultVariant),
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
    `Schema: ${reported(flag.schema)}`,
    `Default Variant ID: ${flag.defaultVariantId}`,
    `Created: ${flag.createdAt}`,
    `Updated: ${flag.updatedAt}`,
  ];
  const variants = formatTable(
    ["VARIANT ID", "NAME", "VALUE", "DESCRIPTION"],
    flag.variants.map((variant) => [
      variant.id,
      variant.name,
      reported(variant.value),
      reported(variant.description),
    ]),
  );
  const configurations = flag.configurations.map(formatConfiguration).join("\n\n");
  return [...definition, "", "Variants", variants, "", "Configurations", configurations].join("\n");
}

function formatConfiguration(
  configuration: HydratedFlagResponse["configurations"][number],
): string {
  const targetingRules = formatTable(
    ["RULE ID", "PRIORITY", "CONDITIONS", "VARIANT ID", "SEGMENT ID", "ROLLOUT"],
    configuration.targetingRules.map((rule) => [
      rule.id,
      reported(rule.priority),
      reported(rule.conditions),
      rule.variantId,
      reported(rule.segmentId),
      reported(rule.percentageRollout),
    ]),
  );
  return [
    `Environment: ${configuration.environmentId}`,
    `Enabled: ${reported(configuration.enabled)}`,
    `Available Variants: ${reported(configuration.availableVariantNames)}`,
    `Rollout: ${reported(configuration.rollout)}`,
    `Experiment: ${reported(configuration.experiment)}`,
    "Targeting Rules",
    targetingRules,
  ].join("\n");
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

function reported(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  return JSON.stringify(value);
}

function formatTable(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => row[index]?.length ?? 0)),
  );
  return [headers, ...rows]
    .map((row) =>
      row
        .map((cell, index) => cell.padEnd(widths[index] ?? 0))
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}
