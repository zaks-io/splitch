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

export function emptyValueEntry(type: ConditionValueEntry["type"] = "string"): ConditionValueEntry {
  return { key: newConditionKey(), text: "", type };
}

export function emptyConditionDraft(): ConditionDraft {
  return {
    key: newConditionKey(),
    attribute: "",
    operator: "eq",
    values: [emptyValueEntry()],
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
    if (!condition.attribute.trim()) {
      issues.push({
        path: `conditions.${index}.attribute`,
        message: "Enter an attribute.",
      });
    }
  });
  return issues;
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
  if (wasList === willList) return { ...condition, operator };
  if (willList) {
    return {
      ...condition,
      operator,
      values: condition.values.length > 0 ? condition.values : [emptyValueEntry()],
    };
  }
  return {
    ...condition,
    operator,
    values:
      condition.values.slice(0, 1).length > 0 ? condition.values.slice(0, 1) : [emptyValueEntry()],
  };
}

function conditionToDraft(condition: Condition): ConditionDraft {
  const values = Array.isArray(condition.value)
    ? condition.value.map(valueEntryFromStored)
    : [valueEntryFromStored(condition.value)];
  return {
    key: newConditionKey(),
    attribute: condition.attribute,
    operator: condition.operator,
    values,
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
  if (
    entry.text !== "" &&
    Number.isFinite(Number(entry.text)) &&
    /^-?\d+(\.\d+)?$/.test(entry.text)
  ) {
    return Number(entry.text);
  }
  return entry.text;
}

function formatStoredValue(value: string | number | boolean): string {
  return String(value);
}

function newConditionKey(): string {
  return `condition_${Math.random().toString(36).slice(2, 10)}`;
}
