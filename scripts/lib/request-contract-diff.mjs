/**
 * Pure diff of two request-contract snapshots (operationId -> { method, path,
 * input JSON Schema }) for changes that make HEAD refuse a request the released
 * contract lets a client send. It walks only the JSON Schema subset zod v4's
 * `z.toJSONSchema` emits for this repo's inputs: objects, arrays, records,
 * const/enum literals, primitive types, and anyOf/oneOf unions.
 */

const MAX_DEPTH = 12;
const PRIMITIVE_TYPES = new Set(["string", "number", "integer", "boolean", "null"]);
const CONSTRAINING_KEYS = ["type", "const", "enum", "anyOf", "oneOf", "properties"];

export function diffRequestContracts(released, head) {
  const violations = [];
  for (const [operationId, before] of Object.entries(released)) {
    const after = head[operationId];
    const report = (path, rule, message) => violations.push({ operationId, path, rule, message });
    if (!after) {
      report("(route)", "route-removed", "the route no longer exists at HEAD");
      continue;
    }
    if (before.method !== after.method || before.path !== after.path) {
      report(
        "(route)",
        "route-moved",
        `${before.method} ${before.path} became ${after.method} ${after.path}`,
      );
    }
    compareSchemas(before.input, after.input, "", 0, report);
  }
  return violations;
}

function compareSchemas(before, after, path, depth, report) {
  if (depth > MAX_DEPTH || acceptsAnything(after) || acceptsAnything(before)) return;
  const was = classify(before);
  const now = classify(after);
  compareLiterals(was, now, path, report);
  comparePrimitives(was, now, path, report);
  compareObjects(was.objects, now.objects, path, depth, report);
  compareArrays(was.arrays, now.arrays, path, depth, report);
}

/** Split a schema into its union members, grouped by the kind of value they accept. */
function classify(schema) {
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

function flattenUnion(schema) {
  const members = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(members)) return members.flatMap(flattenUnion);
  if (Array.isArray(schema.type)) {
    return schema.type.map((type) => ({ ...schema, type }));
  }
  return [schema];
}

function acceptsAnything(schema) {
  return schema === true || (isSchema(schema) && !CONSTRAINING_KEYS.some((key) => key in schema));
}

function isObjectSchema(schema) {
  return schema.type === "object" || "properties" in schema;
}

function jsonTypeOf(value) {
  if (value === null) return "null";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

function acceptsPrimitive(shape, type) {
  if (shape.open || shape.primitives.has(type)) return true;
  return type === "integer" && shape.primitives.has("number");
}

function compareLiterals(was, now, path, report) {
  const lost = was.literals.filter(
    (value) =>
      !now.literals.some((kept) => kept === value) && !acceptsPrimitive(now, jsonTypeOf(value)),
  );
  if (lost.length > 0) {
    report(
      path,
      "literal-removed",
      `no longer accepts ${lost.map((value) => JSON.stringify(value)).join(", ")}`,
    );
  }
}

function comparePrimitives(was, now, path, report) {
  for (const type of was.primitives) {
    if (acceptsPrimitive(now, type)) continue;
    const limitedToLiterals = now.literals.some((value) => jsonTypeOf(value) === type);
    report(
      path,
      "type-narrowed",
      limitedToLiterals
        ? `accepted any ${type}, now only a fixed set of values`
        : `no longer accepts ${type}`,
    );
  }
}

function compareObjects(was, now, path, depth, report) {
  if (was.length === 0) return;
  if (now.length === 0) {
    report(path, "type-narrowed", "no longer accepts an object");
    return;
  }
  if (was.length === 1 && now.length === 1) {
    compareObject(was[0], now[0], path, depth, report);
    return;
  }
  const key = discriminatorOf(was);
  if (!key) return;
  for (const variant of was) {
    const tag = variant.properties[key].const;
    const match = now.find((candidate) => candidate.properties?.[key]?.const === tag);
    if (match) compareObject(variant, match, path, depth, report);
    else report(join(path, key), "variant-removed", `no longer accepts ${JSON.stringify(tag)}`);
  }
}

/** The property every union member pins to a distinct `const`, if one exists. */
function discriminatorOf(members) {
  const candidates = Object.keys(members[0].properties ?? {});
  return candidates.find((key) => {
    const tags = members.map((member) => member.properties?.[key]?.const);
    return tags.every((tag) => tag !== undefined) && new Set(tags).size === tags.length;
  });
}

function compareObject(before, after, path, depth, report) {
  reportNewlyRequired(before, after, path, report);
  for (const [field, schema] of Object.entries(before.properties ?? {})) {
    compareField(field, schema, after, join(path, field), depth, report);
  }
  if (isSchema(before.additionalProperties) && isSchema(after.additionalProperties)) {
    compareSchemas(
      before.additionalProperties,
      after.additionalProperties,
      join(path, "*"),
      depth + 1,
      report,
    );
  }
}

function reportNewlyRequired(before, after, path, report) {
  const wasRequired = new Set(before.required ?? []);
  for (const field of after.required ?? []) {
    if (wasRequired.has(field)) continue;
    report(
      join(path, field),
      "required-added",
      field in (before.properties ?? {})
        ? "optional in the release, required at HEAD"
        : "absent in the release, required at HEAD",
    );
  }
}

/** A released field is fine if HEAD declares it, stripped if HEAD is open, refused if strict. */
function compareField(field, schema, after, path, depth, report) {
  const declared = after.properties?.[field];
  if (declared) compareSchemas(schema, declared, path, depth + 1, report);
  else if (after.additionalProperties === false) {
    report(path, "field-removed", "accepted by the release, rejected by HEAD");
  } else if (isSchema(after.additionalProperties)) {
    compareSchemas(schema, after.additionalProperties, path, depth + 1, report);
  }
}

function compareArrays(was, now, path, depth, report) {
  if (was.length === 0) return;
  if (now.length === 0) {
    report(path, "type-narrowed", "no longer accepts an array");
    return;
  }
  if (was.length === 1 && now.length === 1 && was[0].items && now[0].items) {
    compareSchemas(was[0].items, now[0].items, `${path}[]`, depth + 1, report);
  }
}

function isSchema(value) {
  return typeof value === "object" && value !== null;
}

function join(path, field) {
  return path ? `${path}.${field}` : field;
}

/**
 * Validate the reviewed allowlist and split violations into those it excuses
 * and those still failing. Entries that excuse nothing are returned as stale so
 * the allowlist cannot silently outlive the skew it was written for.
 */
export function applyAllowlist(violations, allowlist) {
  const problems = validateAllowlist(allowlist);
  const entries = Array.isArray(allowlist) ? allowlist : [];
  const keyOf = (item) => `${item.operationId}\u0000${item.path}`;
  const allowed = new Set(entries.map(keyOf));
  const matched = new Set(violations.map(keyOf).filter((key) => allowed.has(key)));
  return {
    problems,
    failing: violations.filter((violation) => !allowed.has(keyOf(violation))),
    excused: violations.filter((violation) => allowed.has(keyOf(violation))),
    stale: entries.filter((entry) => !matched.has(keyOf(entry))),
  };
}

function validateAllowlist(entries) {
  if (!Array.isArray(entries)) return ["allowlist must be a JSON array"];
  const problems = [];
  const seen = new Set();
  entries.forEach((entry, index) => {
    for (const field of ["operationId", "path", "reason"]) {
      if (typeof entry?.[field] !== "string" || entry[field].trim() === "") {
        problems.push(`entry ${index} needs a non-empty string "${field}"`);
      }
    }
    const key = `${entry?.operationId} ${entry?.path}`;
    if (seen.has(key)) problems.push(`entry ${index} duplicates ${key}`);
    seen.add(key);
  });
  return problems;
}
