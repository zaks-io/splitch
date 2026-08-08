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

const ConditionDraftSchema = z
  .object({
    key: z.string(),
    attribute: z.string(),
    operator: ConditionOperatorSchema,
    valueText: z.string(),
  })
  .strict();

export const SegmentDraftSchema = z
  .object({
    name: z.string(),
    description: z.string(),
    conditions: z.array(ConditionDraftSchema),
  })
  .strict();

export type ConditionDraft = z.infer<typeof ConditionDraftSchema>;
export type SegmentDraft = z.infer<typeof SegmentDraftSchema>;

export type SegmentDraftIssue = {
  path: string;
  message: string;
};

export function emptyConditionDraft(): ConditionDraft {
  return { key: newConditionKey(), attribute: "", operator: "eq", valueText: "" };
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
    conditions:
      segment.conditions.length > 0
        ? segment.conditions.map(conditionToDraft)
        : [emptyConditionDraft()],
  };
}

export function segmentDraftIssues(draft: SegmentDraft): SegmentDraftIssue[] {
  const issues: SegmentDraftIssue[] = [];
  if (!draft.name.trim()) {
    issues.push({ path: "name", message: "Enter a Segment name." });
  }
  if (draft.conditions.length === 0) {
    issues.push({ path: "conditions", message: "Add at least one Condition." });
  }
  draft.conditions.forEach((condition, index) => {
    if (!condition.attribute.trim()) {
      issues.push({
        path: `conditions.${index}.attribute`,
        message: "Enter an attribute.",
      });
    }
    if (isListOperator(condition.operator)) {
      if (listValues(condition.valueText).length === 0) {
        issues.push({
          path: `conditions.${index}.valueText`,
          message: "Enter at least one list value.",
        });
      }
    } else if (!condition.valueText.trim()) {
      issues.push({
        path: `conditions.${index}.valueText`,
        message: "Enter a value.",
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

export function formatConditionSummary(condition: Condition): string {
  const value = Array.isArray(condition.value)
    ? condition.value.map(String).join(", ")
    : String(condition.value);
  return `${condition.attribute} ${OPERATOR_LABELS[condition.operator]} ${value}`;
}

function conditionToDraft(condition: Condition): ConditionDraft {
  return {
    key: newConditionKey(),
    attribute: condition.attribute,
    operator: condition.operator,
    valueText: Array.isArray(condition.value)
      ? condition.value.map(String).join(", ")
      : String(condition.value),
  };
}

function conditionFromDraft(draft: ConditionDraft): Condition {
  if (isListOperator(draft.operator)) {
    return {
      attribute: draft.attribute.trim(),
      operator: draft.operator,
      value: listValues(draft.valueText).map(parseScalar),
    };
  }
  return {
    attribute: draft.attribute.trim(),
    operator: draft.operator,
    value: parseScalar(draft.valueText.trim()),
  };
}

function listValues(valueText: string): string[] {
  return valueText
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function parseScalar(raw: string): boolean | number | string {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw !== "" && Number.isFinite(Number(raw)) && /^-?\d+(\.\d+)?$/.test(raw)) {
    return Number(raw);
  }
  return raw;
}

function newConditionKey(): string {
  return `condition_${Math.random().toString(36).slice(2, 10)}`;
}
