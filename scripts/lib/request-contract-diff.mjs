/**
 * Pure diff of two request-contract snapshots (operationId -> { method, path,
 * idempotency, input JSON Schema }) for changes that make HEAD refuse a request
 * the released contract lets a client send. It walks the JSON Schema subset zod
 * v4's `z.toJSONSchema` emits for this repo's inputs: objects, records, arrays,
 * const/enum literals, primitive types, and anyOf/oneOf unions. Anything else
 * (allOf, $ref, not, if) is reported as unsupported rather than skipped.
 */

const MAX_DEPTH = 12;
const PRIMITIVE_TYPES = new Set(["string", "number", "integer", "boolean", "null"]);
const CONSTRAINING_KEYS = ["type", "const", "enum", "anyOf", "oneOf", "properties"];
const UNSUPPORTED_KEYS = ["$ref", "allOf", "not", "if"];
const PATH_PARAM = /:([A-Za-z_][A-Za-z0-9_]*)/g;
// parseInput always builds these from the URL, so a client can never omit them.
const RUNTIME_SUPPLIED = new Set(["params", "query"]);

export function diffRequestContracts(released, head) {
  const violations = [];
  for (const [operationId, before] of Object.entries(released)) {
    compareRoute(before, head[operationId], (path, rule, message) =>
      violations.push({ operationId, path, rule, message }),
    );
  }
  return violations;
}

function compareRoute(before, after, report) {
  if (!after) {
    report("(route)", "route-removed", "the route no longer exists at HEAD");
    return;
  }
  if (before.method !== after.method || pathShape(before.path) !== pathShape(after.path)) {
    report(
      "(route)",
      "route-moved",
      `${before.method} ${before.path} became ${after.method} ${after.path}`,
    );
    return;
  }
  if (after.idempotency === "required" && before.idempotency !== "required") {
    report(
      "headers.Idempotency-Key",
      "required-added",
      `was ${before.idempotency} in the release, required at HEAD`,
    );
  }
  compareSchemas(before.input, alignPathParams(before, after), "", 0, report);
}

// Path param names never reach the wire: the client only fills in the URL. A
// rename (:flagId -> :flagKey) is compatible, so compare by URL position.
function pathShape(path) {
  return path.replace(PATH_PARAM, ":");
}

function alignPathParams(before, after) {
  const params = after.input.properties?.params;
  if (!params?.properties) return after.input;
  const names = [...after.path.matchAll(PATH_PARAM)].map((match) => match[1]);
  const released = [...before.path.matchAll(PATH_PARAM)].map((match) => match[1]);
  const rename = (name) => released[names.indexOf(name)] ?? name;
  const aligned = {
    ...params,
    properties: Object.fromEntries(
      Object.entries(params.properties).map(([name, schema]) => [rename(name), schema]),
    ),
    ...(params.required ? { required: params.required.map(rename) } : {}),
  };
  return { ...after.input, properties: { ...after.input.properties, params: aligned } };
}

function compareSchemas(before, after, path, depth, report) {
  if (depth > MAX_DEPTH) return;
  const unsupported = [before, after].flatMap(flattenUnion).find(usesUnsupportedKeyword);
  if (unsupported) {
    report(path, "unsupported-schema", "uses allOf/$ref/not/if, which this gate cannot compare");
    return;
  }
  if (acceptsAnything(after)) return;
  if (acceptsAnything(before)) {
    report(path, "type-narrowed", "accepted any value in the release, HEAD constrains it");
    return;
  }
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
  if (!isSchema(schema)) return [];
  const members = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(members)) return members.flatMap(flattenUnion);
  if (Array.isArray(schema.type)) return schema.type.map((type) => ({ ...schema, type }));
  return [schema];
}

function usesUnsupportedKeyword(schema) {
  return UNSUPPORTED_KEYS.some((key) => key in schema);
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

function acceptsValue(schema, value) {
  if (!isSchema(schema)) return false;
  const shape = classify(schema);
  return shape.literals.includes(value) || acceptsPrimitive(shape, jsonTypeOf(value));
}

function compareLiterals(was, now, path, report) {
  const lost = was.literals.filter(
    (value) => !now.literals.includes(value) && !acceptsPrimitive(now, jsonTypeOf(value)),
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

/**
 * Each released object variant is compared with the HEAD variant that accepts
 * it best: among those still accepting its discriminator tag when the released
 * union has one, otherwise among all HEAD object variants.
 */
function compareObjects(was, now, path, depth, report) {
  if (was.length === 0) return;
  if (now.length === 0) {
    report(path, "type-narrowed", "no longer accepts an object");
    return;
  }
  const key = was.length > 1 ? discriminatorOf(was) : undefined;
  for (const variant of was) {
    const tag = key && variant.properties[key].const;
    const candidates = key
      ? now.filter((candidate) => acceptsValue(candidate.properties?.[key], tag))
      : now;
    if (candidates.length === 0) {
      report(join(path, key), "variant-removed", `no longer accepts ${JSON.stringify(tag)}`);
    } else {
      replayClosest(variant, candidates, path, depth, report);
    }
  }
}

function replayClosest(variant, candidates, path, depth, report) {
  let closest;
  for (const candidate of candidates) {
    const found = [];
    compareObject(variant, candidate, path, depth, (...violation) => found.push(violation));
    if (!closest || found.length < closest.length) closest = found;
  }
  for (const violation of closest) report(...violation);
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
  compareOpenKeys(before, after, path, depth, report);
}

function reportNewlyRequired(before, after, path, report) {
  const wasRequired = new Set(before.required ?? []);
  for (const field of after.required ?? []) {
    if (wasRequired.has(field) || (path === "" && RUNTIME_SUPPLIED.has(field))) continue;
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

/** Records and loose objects: keys beyond the declared properties. */
function compareOpenKeys(before, after, path, depth, report) {
  if (!isSchema(before.additionalProperties)) return;
  const keysPath = join(path, "*");
  if (after.additionalProperties === false) {
    report(
      keysPath,
      "field-removed",
      "accepted arbitrary keys in the release, HEAD accepts only declared keys",
    );
    return;
  }
  if (!isSchema(after.additionalProperties)) return;
  compareSchemas(
    before.additionalProperties,
    after.additionalProperties,
    keysPath,
    depth + 1,
    report,
  );
  if (isSchema(after.propertyNames)) {
    const releasedKeys = before.propertyNames ?? { type: "string" };
    compareSchemas(releasedKeys, after.propertyNames, join(path, "(key)"), depth + 1, report);
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
