/**
 * Classification helpers over the JSON Schema subset zod v4's `z.toJSONSchema`
 * emits: which kinds of value a schema (or each member of its union) accepts.
 */

const PRIMITIVE_TYPES = new Set(["string", "number", "integer", "boolean", "null"]);
const CONSTRAINING_KEYS = ["type", "const", "enum", "anyOf", "oneOf", "properties"];
const UNSUPPORTED_KEYS = ["$ref", "allOf", "not", "if"];

export function isSchema(value) {
  return typeof value === "object" && value !== null;
}

/**
 * Split a schema into its union members grouped by the kind of value they
 * accept. `open` means some member accepts every value, which dominates the
 * per-kind groups.
 */
export function classify(schema) {
  const shape = { literals: [], primitives: new Set(), objects: [], arrays: [], open: false };
  for (const member of flattenUnion(schema)) {
    if (acceptsAnything(member)) shape.open = true;
    else if ("const" in member) shape.literals.push(member.const);
    else if (Array.isArray(member.enum)) shape.literals.push(...member.enum);
    else addStructured(shape, member);
  }
  return shape;
}

function addStructured(shape, member) {
  if (isObjectSchema(member)) shape.objects.push(member);
  else if (member.type === "array") shape.arrays.push(member);
  else if (PRIMITIVE_TYPES.has(member.type)) shape.primitives.add(member.type);
}

export function flattenUnion(schema) {
  if (schema === true) return [{}];
  if (!isSchema(schema)) return [];
  const members = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(members)) return members.flatMap(flattenUnion);
  if (Array.isArray(schema.type)) return schema.type.map((type) => ({ ...schema, type }));
  return [schema];
}

export function usesUnsupportedKeyword(schema) {
  return UNSUPPORTED_KEYS.some((key) => key in schema);
}

function acceptsAnything(schema) {
  return isSchema(schema) && !CONSTRAINING_KEYS.some((key) => key in schema);
}

function isObjectSchema(schema) {
  return schema.type === "object" || "properties" in schema;
}

export function jsonTypeOf(value) {
  if (value === null) return "null";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

export function acceptsPrimitive(shape, type) {
  if (shape.open || shape.primitives.has(type)) return true;
  return type === "integer" && shape.primitives.has("number");
}

export function acceptsValue(schema, value) {
  if (!isSchema(schema)) return false;
  const shape = classify(schema);
  return shape.literals.includes(value) || acceptsPrimitive(shape, jsonTypeOf(value));
}

/**
 * The schema undeclared object keys must match: an absent or `true`
 * additionalProperties (zod's stripping and loose objects) accepts any key, so
 * it reads as the unconstrained schema `{}`; `false` (strict) rejects them.
 */
export function undeclaredKeys(schema) {
  const keys = schema.additionalProperties;
  return keys === undefined || keys === true ? {} : keys;
}
