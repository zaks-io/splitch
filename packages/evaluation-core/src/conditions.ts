import type { Condition, EvaluationContext, ResolvedTargetingRule } from "@splitch/contracts";
import { ConditionMatchError } from "./errors";

export interface ConditionMatchOptions {
  logger?: Pick<Console, "warn">;
  ruleId?: string;
}

export function matchesConditions(
  conditions: ResolvedTargetingRule["conditions"],
  context: EvaluationContext,
  options: ConditionMatchOptions = {},
): boolean {
  if (conditions.length === 0)
    throw new ConditionMatchError("resolved Targeting Rule has no Conditions");
  return conditions.every((condition) => matchesCondition(condition, context, options));
}

function matchesCondition(
  condition: Condition,
  context: EvaluationContext,
  options: ConditionMatchOptions,
): boolean {
  const actual = contextValue(context, condition.attribute);
  if (actual.value === null || actual.value === undefined) {
    options.logger?.warn("condition_attribute_absent", {
      attribute: condition.attribute,
      hasAttribute: actual.hasAttribute,
      operator: condition.operator,
      ruleId: options.ruleId ?? null,
    });
    return false;
  }
  switch (condition.operator) {
    case "eq":
      return Object.is(actual.value, condition.value);
    case "neq":
      return !Object.is(actual.value, condition.value);
    case "gt":
      return compareNumbers(actual.value, condition.value, (a, b) => a > b);
    case "lt":
      return compareNumbers(actual.value, condition.value, (a, b) => a < b);
    case "gte":
      return compareNumbers(actual.value, condition.value, (a, b) => a >= b);
    case "lte":
      return compareNumbers(actual.value, condition.value, (a, b) => a <= b);
    case "in":
      return (
        Array.isArray(condition.value) &&
        condition.value.some((value) => Object.is(value, actual.value))
      );
    case "not_in":
      return (
        Array.isArray(condition.value) &&
        !condition.value.some((value) => Object.is(value, actual.value))
      );
    case "matches":
      return matchesRegex(actual.value, condition.value);
    case "not_matches":
      return !matchesRegex(actual.value, condition.value);
  }
}

function contextValue(context: EvaluationContext, attribute: string) {
  if (attribute === "targetingKey") return { hasAttribute: true, value: context.targetingKey };
  if (attribute === "idType") return { hasAttribute: true, value: context.idType };
  return {
    hasAttribute: Object.hasOwn(context.attributes, attribute),
    value: context.attributes[attribute] ?? null,
  };
}

function compareNumbers(
  actual: unknown,
  expected: unknown,
  predicate: (a: number, b: number) => boolean,
) {
  return typeof actual === "number" && typeof expected === "number" && predicate(actual, expected);
}

function matchesRegex(actual: unknown, expected: unknown): boolean {
  if (typeof actual !== "string" || typeof expected !== "string") return false;
  try {
    return new RegExp(expected).test(actual);
  } catch (cause) {
    throw new ConditionMatchError(
      `Invalid regex condition "${expected}"`,
      "INTERNAL_SERVER_ERROR",
      { cause },
    );
  }
}
