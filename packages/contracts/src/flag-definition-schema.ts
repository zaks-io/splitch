/**
 * The supported JSON Schema subset for a Flag's value schema, and the one
 * validator both sides run against it: the Control Plane Worker when a Flag or
 * Variant is written, and the Control Panel while the draft is still on screen.
 * Living here keeps the two verdicts identical — a schema the panel accepts is
 * a schema the Worker accepts.
 */

export interface ValidationIssue {
  path: string[];
  message: string;
}

export function schemaDefinitionIssues(
  schema: Record<string, unknown> | null,
  path: string[],
): ValidationIssue[] {
  if (!schema) return [];

  const issues = unsupportedKeywordIssues(schema, path);
  const types = schemaTypes(schema.type);
  if (types.some((type) => !SUPPORTED_JSON_TYPES.has(type))) {
    issues.push({ path: [...path, "type"], message: "unsupported JSON Schema type" });
  }
  if ("pattern" in schema && !isValidPattern(schema.pattern)) {
    issues.push({ path: [...path, "pattern"], message: "pattern must be a valid regex string" });
  }
  if (isPlainRecord(schema.properties)) {
    for (const [key, childSchema] of Object.entries(schema.properties)) {
      if (isPlainRecord(childSchema)) {
        issues.push(...schemaDefinitionIssues(childSchema, [...path, "properties", key]));
      }
    }
  }
  return issues;
}

export function validateJsonSchema(
  schema: Record<string, unknown> | null,
  value: unknown,
  path: string[],
): ValidationIssue[] {
  if (!schema) return [];

  const issues: ValidationIssue[] = [];
  if (Array.isArray(schema.enum) && !schema.enum.some((item) => deepEqual(item, value))) {
    issues.push({ path, message: "value must match one of the schema enum values" });
  }
  if ("const" in schema && !deepEqual(schema.const, value)) {
    issues.push({ path, message: "value must match the schema const value" });
  }

  const types = schemaTypes(schema.type);
  if (types.length > 0 && !types.some((type) => matchesJsonType(type, value))) {
    issues.push({ path, message: `value must satisfy schema type ${types.join("|")}` });
    return issues;
  }

  if (isPlainRecord(value)) {
    issues.push(...objectSchemaIssues(schema, value, path));
  }
  if (typeof value === "number") {
    issues.push(...numberSchemaIssues(schema, value, path));
  }
  if (typeof value === "string") {
    issues.push(...stringSchemaIssues(schema, value, path));
  }

  return issues;
}

function objectSchemaIssues(
  schema: Record<string, unknown>,
  value: Record<string, unknown>,
  path: string[],
): ValidationIssue[] {
  return [
    ...requiredPropertyIssues(schema, value, path),
    ...childPropertyIssues(schema, value, path),
    ...additionalPropertyIssues(schema, value, path),
  ];
}

function requiredPropertyIssues(
  schema: Record<string, unknown>,
  value: Record<string, unknown>,
  path: string[],
): ValidationIssue[] {
  const required = Array.isArray(schema.required) ? schema.required : [];
  const issues: ValidationIssue[] = [];
  for (const key of required) {
    if (typeof key === "string" && !(key in value)) {
      issues.push({ path: [...path, key], message: "required property is missing" });
    }
  }
  return issues;
}

function childPropertyIssues(
  schema: Record<string, unknown>,
  value: Record<string, unknown>,
  path: string[],
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (isPlainRecord(schema.properties)) {
    for (const [key, childSchema] of Object.entries(schema.properties)) {
      if (key in value && isPlainRecord(childSchema)) {
        issues.push(...validateJsonSchema(childSchema, value[key], [...path, key]));
      }
    }
  }
  return issues;
}

function additionalPropertyIssues(
  schema: Record<string, unknown>,
  value: Record<string, unknown>,
  path: string[],
): ValidationIssue[] {
  if (schema.additionalProperties !== false || !isPlainRecord(schema.properties)) return [];

  const allowed = new Set(Object.keys(schema.properties));
  const issues: ValidationIssue[] = [];
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      issues.push({ path: [...path, key], message: "unknown property" });
    }
  }
  return issues;
}

function numberSchemaIssues(
  schema: Record<string, unknown>,
  value: number,
  path: string[],
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (typeof schema.minimum === "number" && value < schema.minimum) {
    issues.push({ path, message: "value must be greater than or equal to schema minimum" });
  }
  if (typeof schema.maximum === "number" && value > schema.maximum) {
    issues.push({ path, message: "value must be less than or equal to schema maximum" });
  }
  if (typeof schema.exclusiveMinimum === "number" && value <= schema.exclusiveMinimum) {
    issues.push({ path, message: "value must be greater than schema exclusiveMinimum" });
  }
  if (typeof schema.exclusiveMaximum === "number" && value >= schema.exclusiveMaximum) {
    issues.push({ path, message: "value must be less than schema exclusiveMaximum" });
  }
  return issues;
}

function stringSchemaIssues(
  schema: Record<string, unknown>,
  value: string,
  path: string[],
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (typeof schema.minLength === "number" && value.length < schema.minLength) {
    issues.push({
      path,
      message: "value length must be greater than or equal to schema minLength",
    });
  }
  if (typeof schema.maxLength === "number" && value.length > schema.maxLength) {
    issues.push({ path, message: "value length must be less than or equal to schema maxLength" });
  }
  if (typeof schema.pattern === "string" && !new RegExp(schema.pattern).test(value)) {
    issues.push({ path, message: "value must match schema pattern" });
  }
  return issues;
}

const SUPPORTED_SCHEMA_KEYS = new Set([
  "additionalProperties",
  "const",
  "enum",
  "exclusiveMaximum",
  "exclusiveMinimum",
  "maximum",
  "maxLength",
  "minimum",
  "minLength",
  "pattern",
  "properties",
  "required",
  "type",
]);

const SUPPORTED_JSON_TYPES = new Set([
  "array",
  "boolean",
  "integer",
  "null",
  "number",
  "object",
  "string",
]);

function unsupportedKeywordIssues(
  schema: Record<string, unknown>,
  path: string[],
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const key of Object.keys(schema)) {
    if (!SUPPORTED_SCHEMA_KEYS.has(key)) {
      issues.push({ path: [...path, key], message: "unsupported JSON Schema keyword" });
    }
  }
  return issues;
}

function isValidPattern(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    new RegExp(value);
    return true;
  } catch {
    return false;
  }
}

function schemaTypes(type: unknown): string[] {
  if (Array.isArray(type)) return type.filter((item): item is string => typeof item === "string");
  return typeof type === "string" ? [type] : [];
}

function matchesJsonType(type: string, value: unknown): boolean {
  if (type === "boolean") return typeof value === "boolean";
  if (type === "string") return typeof value === "string";
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  if (type === "integer") return Number.isInteger(value);
  if (type === "object") return isPlainRecord(value);
  if (type === "array") return Array.isArray(value);
  if (type === "null") return value === null;
  return true;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
