import {
  type Condition,
  type ConditionOperator,
  ConditionOperatorSchema,
  type CreateSegmentRequest,
  conditionOperators,
  type PatchSegmentRequest,
  type Segment,
} from "@splitch/contracts";
import { z } from "zod";

const OPERATOR_LABELS: Record<ConditionOperator, string> = {
  eq: "equals",
  neq: "does not equal",
  gt: "greater than",
  lt: "less than",
  gte: "greater than or equal",
  lte: "less than or equal",
  in: "in list",
  not_in: "not in list",
  matches: "matches",
  not_matches: "does not match",
};

export type ConditionValueType = "string" | "number" | "boolean";

export function conditionOperatorOptions(): ReadonlyArray<{
  operator: ConditionOperator;
  label: string;
}> {
  return conditionOperators.map((operator) => ({
    operator,
    label: OPERATOR_LABELS[operator],
  }));
}

export function isListOperator(operator: ConditionOperator): boolean {
  return operator === "in" || operator === "not_in";
}

/**
 * Operators whose value type is fixed by the operator itself. Polymorphic
 * operators (`eq` / `neq` / `in` / `not_in`) leave the type to the author.
 */
export function forcedValueType(operator: ConditionOperator): ConditionValueType | null {
  if (operator === "gt" || operator === "gte" || operator === "lt" || operator === "lte") {
    return "number";
  }
  if (operator === "matches" || operator === "not_matches") {
    return "string";
  }
  return null;
}

export function isPolymorphicValueOperator(operator: ConditionOperator): boolean {
  return forcedValueType(operator) === null;
}

const ConditionValueEntrySchema = z
  .object({
    key: z.string(),
    text: z.string(),
    type: z.union([z.literal("string"), z.literal("number"), z.literal("boolean")]),
  })
  .strict();

const ConditionDraftSchema = z
  .object({
    key: z.string(),
    attribute: z.string(),
    operator: ConditionOperatorSchema,
    values: z.array(ConditionValueEntrySchema),
  })
  .strict();

export const SegmentDraftSchema = z
  .object({
    name: z.string(),
    description: z.string(),
    conditions: z.array(ConditionDraftSchema),
  })
  .strict();

export type ConditionValueEntry = z.infer<typeof ConditionValueEntrySchema>;
export type ConditionDraft = z.infer<typeof ConditionDraftSchema>;
export type SegmentDraft = z.infer<typeof SegmentDraftSchema>;

export type SegmentDraftIssue = {
  path: string;
  message: string;
};

export function emptyValueEntry(type: ConditionValueType): ConditionValueEntry {
  return {
    key: newConditionKey(),
    text: type === "boolean" ? "true" : "",
    type,
  };
}

export function emptyConditionDraft(): ConditionDraft {
  return {
    key: newConditionKey(),
    attribute: "",
    operator: "eq",
    values: [emptyValueEntry("string")],
  };
}

export function emptySegmentDraft(): SegmentDraft {
  return {
    name: "",
    description: "",
    conditions: [emptyConditionDraft()],
  };
}

export function segmentDraft(segment: Segment): SegmentDraft {
  return {
    name: segment.name,
    description: segment.description ?? "",
    conditions: segment.conditions.map(conditionToDraft),
  };
}

export function segmentDraftIssues(draft: SegmentDraft): SegmentDraftIssue[] {
  const issues: SegmentDraftIssue[] = [];
  if (!draft.name.trim()) {
    issues.push({ path: "name", message: "Enter a Segment name." });
  }
  draft.conditions.forEach((condition, index) => {
    issues.push(...conditionDraftIssues(condition, index));
  });
  return issues;
}

function conditionDraftIssues(condition: ConditionDraft, index: number): SegmentDraftIssue[] {
  const issues: SegmentDraftIssue[] = [];
  if (!condition.attribute.trim()) {
    issues.push({
      path: `conditions.${index}.attribute`,
      message: "Enter an attribute.",
    });
  }
  const valueIssue = conditionValueIssue(condition);
  if (valueIssue) {
    issues.push({ path: `conditions.${index}.value`, message: valueIssue });
  }
  return issues;
}

function conditionValueIssue(condition: ConditionDraft): string | undefined {
  if (isListOperator(condition.operator)) {
    for (const entry of condition.values) {
      const entryIssue = valueEntryIssue(entry);
      if (entryIssue) return entryIssue;
    }
    return undefined;
  }
  const only =
    condition.values[0] ?? emptyValueEntry(forcedValueType(condition.operator) ?? "string");
  return valueEntryIssue(only);
}

export function segmentCreateInput(draft: SegmentDraft): CreateSegmentRequest {
  return {
    name: draft.name.trim(),
    ...(draft.description.trim() ? { description: draft.description.trim() } : {}),
    conditions: draft.conditions.map(conditionFromDraft),
  };
}

export function segmentUpdateInput(draft: SegmentDraft): PatchSegmentRequest {
  return {
    name: draft.name.trim(),
    description: draft.description.trim(),
    conditions: draft.conditions.map(conditionFromDraft),
  };
}

export function segmentIssueFor(
  issues: readonly SegmentDraftIssue[],
  path: string,
): string | undefined {
  return issues.find((issue) => issue.path === path)?.message;
}

export function formatConditionSummary(condition: {
  attribute: string;
  operator: string;
  value: Condition["value"] | string;
}): string {
  const value = Array.isArray(condition.value)
    ? condition.value.map(formatStoredValue).join(", ")
    : formatStoredValue(condition.value);
  const label =
    condition.operator in OPERATOR_LABELS
      ? OPERATOR_LABELS[condition.operator as ConditionOperator]
      : condition.operator;
  return `${condition.attribute} ${label} ${value}`;
}

export function conditionWithOperator(
  condition: ConditionDraft,
  operator: ConditionOperator,
): ConditionDraft {
  const wasList = isListOperator(condition.operator);
  const willList = isListOperator(operator);
  const defaultType = forcedValueType(operator) ?? "string";
  let values: ConditionValueEntry[];
  if (wasList === willList) {
    values = condition.values;
  } else if (willList) {
    values = condition.values.length > 0 ? condition.values : [emptyValueEntry(defaultType)];
  } else {
    values =
      condition.values.slice(0, 1).length > 0
        ? condition.values.slice(0, 1)
        : [emptyValueEntry(defaultType)];
  }
  const forced = forcedValueType(operator);
  if (forced) {
    values = values.map((entry) => coerceEntryType(entry, forced));
  }
  return { ...condition, operator, values };
}

function conditionToDraft(condition: Condition): ConditionDraft {
  const values = Array.isArray(condition.value)
    ? condition.value.map(valueEntryFromStored)
    : [valueEntryFromStored(condition.value)];
  const forced = forcedValueType(condition.operator);
  return {
    key: newConditionKey(),
    attribute: condition.attribute,
    operator: condition.operator,
    values: forced ? values.map((entry) => coerceEntryType(entry, forced)) : values,
  };
}

function conditionFromDraft(draft: ConditionDraft): Condition {
  if (isListOperator(draft.operator) || draft.values.length !== 1) {
    return {
      attribute: draft.attribute.trim(),
      operator: draft.operator,
      value: draft.values.map(emitStoredValue),
    };
  }
  const only = draft.values[0];
  return {
    attribute: draft.attribute.trim(),
    operator: draft.operator,
    value: only ? emitStoredValue(only) : "",
  };
}

function valueEntryFromStored(value: string | number | boolean): ConditionValueEntry {
  if (typeof value === "boolean") {
    return { key: newConditionKey(), text: value ? "true" : "false", type: "boolean" };
  }
  if (typeof value === "number") {
    return { key: newConditionKey(), text: String(value), type: "number" };
  }
  return { key: newConditionKey(), text: value, type: "string" };
}

function emitStoredValue(entry: ConditionValueEntry): string | number | boolean {
  if (entry.type === "string") return entry.text;
  if (entry.type === "boolean") {
    if (entry.text === "true") return true;
    if (entry.text === "false") return false;
    return entry.text;
  }
  return Number(entry.text);
}

function valueEntryIssue(entry: ConditionValueEntry): string | undefined {
  if (entry.type === "number") {
    if (entry.text.trim() === "" || !Number.isFinite(Number(entry.text))) {
      return "Enter a number.";
    }
    return undefined;
  }
  if (entry.text === "") {
    return "Enter a value.";
  }
  return undefined;
}

function coerceEntryType(
  entry: ConditionValueEntry,
  type: ConditionValueType,
): ConditionValueEntry {
  if (entry.type === type) return entry;
  if (type === "boolean") {
    return {
      ...entry,
      type,
      text: entry.text === "false" ? "false" : "true",
    };
  }
  return { ...entry, type };
}

function formatStoredValue(value: string | number | boolean): string {
  return String(value);
}

function newConditionKey(): string {
  return `condition_${Math.random().toString(36).slice(2, 10)}`;
}
