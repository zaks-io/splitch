import { randomUUID } from "node:crypto";
import { TargetingRuleSchema, type TargetingRule } from "@splitch/sdk/control-plane";
import type { CliIo, CliResult } from "./execute-types.js";
import { EXIT_USAGE } from "./exit-codes.js";
import { CliInputError } from "./flag-create-input.js";
import { writeCliError } from "./errors.js";
import type { ParsedInvocation } from "./parse-args.js";

export interface ParsedWhenCondition {
  readonly attribute: string;
  readonly operator: "eq";
  readonly value: string;
}

export interface FlagTargetingRulesAddInput {
  readonly conditions: readonly ParsedWhenCondition[];
  readonly variantName: string;
}

export function parseFlagTargetingRulesAddInput(
  invocation: ParsedInvocation,
): FlagTargetingRulesAddInput {
  if (invocation.flags.bodyJson) {
    throw addInputError(
      "flag-targeting-rules add does not accept --body-json",
      "bodyJson",
      "raw_replace_path",
      "Use flag-targeting-rules replace --body-json for the raw full-replace path",
    );
  }
  const whenFlags = invocation.flags.when;
  if (whenFlags.length === 0) {
    throw addInputError(
      "flag-targeting-rules add requires --when attr=value",
      "when",
      "missing_when",
      "Pass at least one --when attr=value equality Condition; repeat --when to AND more",
    );
  }
  const variantName = invocation.flags.serve?.trim();
  if (!variantName) {
    throw addInputError(
      "flag-targeting-rules add requires --serve <variant>",
      "serve",
      "missing_serve",
      "Pass the catalog Variant name to serve when the Conditions match",
    );
  }
  return {
    conditions: whenFlags.map((token) => parseWhenCondition(token)),
    variantName,
  };
}

export function parseWhenCondition(token: string): ParsedWhenCondition {
  const separator = token.indexOf("=");
  if (separator <= 0 || separator === token.length - 1) {
    throw malformedWhen(token);
  }
  const attribute = token.slice(0, separator).trim();
  const rawValue = token.slice(separator + 1).trim();
  if (!attribute || !rawValue) {
    throw malformedWhen(token);
  }
  return { attribute, operator: "eq", value: rawValue };
}

export function resolveVariantByName(
  variants: readonly { readonly id: string; readonly name: string }[],
  variantName: string,
): { readonly id: string; readonly name: string } {
  const matches = variants.filter((variant) => variant.name === variantName);
  if (matches.length === 0) {
    const known = variants.map((variant) => variant.name);
    throw addInputError(
      `Unknown Variant "${variantName}"`,
      "serve",
      "unknown_variant",
      known.length > 0
        ? `Pass a catalog Variant name. Known names: ${known.join(", ")}`
        : "Pass a catalog Variant name. This Flag has no Variants; inspect it with splitch flags get",
    );
  }
  if (matches.length > 1) {
    throw addInputError(
      `Variant name "${variantName}" matches more than one catalog entry`,
      "serve",
      "ambiguous_variant",
      "Pass a unique catalog Variant name, or inspect the catalog with splitch flags get",
    );
  }
  const match = matches[0];
  if (!match) {
    throw addInputError(
      `Unknown Variant "${variantName}"`,
      "serve",
      "unknown_variant",
      "Pass a catalog Variant name",
    );
  }
  return match;
}

export function mintTargetingRuleId(): string {
  return `rule_${randomUUID().replaceAll("-", "")}`;
}

export function nextRulePriority(rules: readonly { readonly priority: number }[]): number {
  if (rules.length === 0) return 0;
  return Math.max(...rules.map((rule) => rule.priority)) + 1;
}

export function buildAppendedTargetingRule(options: {
  readonly flagId: string;
  readonly existing: readonly TargetingRule[];
  readonly conditions: readonly ParsedWhenCondition[];
  readonly variantId: string;
  readonly id?: string;
}): TargetingRule {
  const rule = {
    id: options.id ?? mintTargetingRuleId(),
    flagId: options.flagId,
    priority: nextRulePriority(options.existing),
    conditions: options.conditions.map((condition) => ({
      attribute: condition.attribute,
      operator: condition.operator,
      value: condition.value,
    })),
    variantId: options.variantId,
    percentageRollout: null,
  };
  const parsed = TargetingRuleSchema.safeParse(rule);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw addInputError(
      `flag-targeting-rules add built an invalid Targeting Rule: ${issue?.message ?? "validation failed"}`,
      issue?.path.join(".") || "targetingRules",
      "contract_validation_failed",
      "Correct --when / --serve and retry, or use flag-targeting-rules replace for the raw path",
    );
  }
  return parsed.data;
}

export function validateFlagTargetingRulesAddUsage(
  invocation: ParsedInvocation,
  io: CliIo,
): CliResult | null {
  try {
    parseFlagTargetingRulesAddInput(invocation);
    return null;
  } catch (error) {
    if (error instanceof CliInputError) {
      writeCliError(io, error);
      return { exitCode: EXIT_USAGE, payload: error.payload };
    }
    throw error;
  }
}

function addInputError(
  message: string,
  field: string,
  reason: string,
  remediation: string,
): CliInputError {
  return new CliInputError(
    {
      code: "CLI_VALIDATION_ERROR",
      message,
      details: { field, reason },
    },
    remediation,
  );
}

function malformedWhen(token: string): CliInputError {
  return addInputError(
    `--when must be attr=value, but received "${token}"`,
    "when",
    "malformed_when",
    "Pass --when attr=value (string equality). Repeat --when to AND Conditions. Number or boolean Condition values require flag-targeting-rules replace --body-json",
  );
}
