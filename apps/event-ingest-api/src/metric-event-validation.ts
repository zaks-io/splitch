import type {
  ClosedJson,
  EventDefinitionVersion,
  MetricEventTrackRequest,
} from "@splitch/contracts";

export interface ValidationIssue {
  readonly path: string[];
  readonly message: string;
}

export function validateMetricEvent(
  event: MetricEventTrackRequest,
  version: EventDefinitionVersion,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (version.entityType !== event.idType) {
    issues.push({
      path: ["idType"],
      message: `expected Entity type ${version.entityType ?? "none"}`,
    });
    return issues;
  }
  validateRecord(event.fields, version.fields, "fields", issues);
  validateRecord(event.dimensions, version.dimensions, "dimensions", issues);
  return issues;
}

function validateRecord(
  values: Record<string, unknown>,
  definitions: readonly FieldDefinition[],
  root: "fields" | "dimensions",
  issues: ValidationIssue[],
): void {
  const declared = new Map(definitions.map((definition) => [definition.name, definition]));
  for (const key of Object.keys(values)) {
    if (!declared.has(key))
      issues.push({ path: [root, key], message: `${root} key is not declared` });
  }
  for (const definition of definitions) {
    const value = ownValue(values, definition.name);
    if (value === undefined) {
      if (definition.required) {
        issues.push({ path: [root, definition.name], message: "required value is missing" });
      }
      continue;
    }
    validateValue(value, definition, [root, definition.name], issues);
  }
}

type FieldDefinition = EventDefinitionVersion["fields"][number];

function ownValue(record: object, key: string): unknown {
  return Object.hasOwn(record, key) ? (record as Record<string, unknown>)[key] : undefined;
}

function validateValue(
  value: unknown,
  definition: FieldDefinition,
  path: string[],
  issues: ValidationIssue[],
): void {
  if (definition.type === "json") {
    validateJson(value, definition.jsonSchema, path, issues);
    return;
  }
  if (typeof value !== definition.type) {
    issues.push({ path, message: `expected ${definition.type}` });
    return;
  }
  if ("allowedValues" in definition && definition.allowedValues !== undefined) {
    const allowed: readonly unknown[] = definition.allowedValues;
    if (!allowed.includes(value)) issues.push({ path, message: "value is not allowed" });
  }
  if (definition.type === "number") validateNumber(value as number, definition, path, issues);
}

function validateNumber(
  value: number,
  definition: { minimum?: number; maximum?: number },
  path: string[],
  issues: ValidationIssue[],
): void {
  if (!Number.isFinite(value)) issues.push({ path, message: "number must be finite" });
  if (definition.minimum !== undefined && value < definition.minimum) {
    issues.push({ path, message: `number must be at least ${definition.minimum}` });
  }
  if (definition.maximum !== undefined && value > definition.maximum) {
    issues.push({ path, message: `number must be at most ${definition.maximum}` });
  }
}

// Recursive closed JSON validation necessarily branches on every supported schema node.
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: splitting would hide the exhaustive recursive dispatch
function validateJson(
  value: unknown,
  schema: ClosedJson,
  path: string[],
  issues: ValidationIssue[],
): void {
  if (schema.type === "object") {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      issues.push({ path, message: "expected object" });
      return;
    }
    const object = value as Record<string, unknown>;
    for (const key of Object.keys(object)) {
      if (!Object.hasOwn(schema.properties, key))
        issues.push({ path: [...path, key], message: "JSON key is not declared" });
    }
    for (const required of schema.required ?? []) {
      if (!Object.hasOwn(object, required))
        issues.push({ path: [...path, required], message: "required JSON key is missing" });
    }
    for (const [key, child] of Object.entries(schema.properties)) {
      if (Object.hasOwn(object, key))
        validateJson(ownValue(object, key), child, [...path, key], issues);
    }
    return;
  }
  if (schema.type === "array") {
    if (!Array.isArray(value)) {
      issues.push({ path, message: "expected array" });
      return;
    }
    if (schema.minItems !== undefined && value.length < schema.minItems)
      issues.push({ path, message: "array is too short" });
    if (schema.maxItems !== undefined && value.length > schema.maxItems)
      issues.push({ path, message: "array is too long" });
    value.forEach((item, index) => {
      validateJson(item, schema.items, [...path, String(index)], issues);
    });
    return;
  }
  const expected = schema.type === "integer" ? "number" : schema.type;
  if (schema.type === "null" ? value !== null : typeof value !== expected) {
    issues.push({ path, message: `expected ${schema.type}` });
    return;
  }
  if (schema.type === "integer" && !Number.isInteger(value))
    issues.push({ path, message: "expected integer" });
  if ("enum" in schema && schema.enum !== undefined && !schema.enum.includes(value as never)) {
    issues.push({ path, message: "value is not allowed" });
  }
  if (typeof value === "number" && (schema.type === "number" || schema.type === "integer")) {
    validateNumber(value, schema, path, issues);
  }
}
