import type { Condition, EvaluationContext, TargetingRule } from "@splitch/contracts";

class ConditionMatchError extends Error {}

export function matchesConditions(
  conditions: TargetingRule["conditions"],
  context: EvaluationContext,
) {
  return conditions.every((condition) => matchesCondition(condition, context));
}

function matchesCondition(condition: Condition, context: EvaluationContext): boolean {
  const actual = contextValue(context, condition.attribute);
  if (actual === null || actual === undefined) {
    return false;
  }

  switch (condition.operator) {
    case "eq":
      return Object.is(actual, condition.value);
    case "neq":
      return !Object.is(actual, condition.value);
    case "gt":
      return compareNumbers(actual, condition.value, (a, b) => a > b);
    case "lt":
      return compareNumbers(actual, condition.value, (a, b) => a < b);
    case "gte":
      return compareNumbers(actual, condition.value, (a, b) => a >= b);
    case "lte":
      return compareNumbers(actual, condition.value, (a, b) => a <= b);
    case "in":
      return (
        Array.isArray(condition.value) && condition.value.some((value) => Object.is(value, actual))
      );
    case "not_in":
      return (
        Array.isArray(condition.value) && !condition.value.some((value) => Object.is(value, actual))
      );
    case "matches":
      return matchesRegex(actual, condition.value);
    case "not_matches":
      return !matchesRegex(actual, condition.value);
  }
}

function contextValue(context: EvaluationContext, attribute: string) {
  if (attribute === "targetingKey") {
    return context.targetingKey;
  }
  if (attribute === "idType") {
    return context.idType;
  }
  return context.attributes[attribute] ?? null;
}

function compareNumbers(
  actual: unknown,
  expected: unknown,
  predicate: (actual: number, expected: number) => boolean,
) {
  return typeof actual === "number" && typeof expected === "number" && predicate(actual, expected);
}

function matchesRegex(actual: unknown, expected: unknown) {
  if (typeof actual !== "string" || typeof expected !== "string") {
    return false;
  }
  try {
    return new RegExp(expected).test(actual);
  } catch (cause) {
    throw new ConditionMatchError(`Invalid regex condition "${expected}"`, { cause });
  }
}
