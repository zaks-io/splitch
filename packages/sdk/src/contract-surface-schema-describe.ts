/**
 * Test-only helpers: derive a structural object descriptor from a contracts
 * Zod schema via `z.toJSONSchema()` + catchall unknown-key policy.
 */

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type {
  JsonTypeNode,
  ObjectShapeDescriptor,
  UnknownKeysPolicy,
} from "../scripts/contract-surface-descriptors";

const requireFromContracts = createRequire(
  fileURLToPath(new URL("../../contracts/package.json", import.meta.url)),
);
const { z } = requireFromContracts("zod") as {
  z: { toJSONSchema: (schema: unknown) => unknown };
};

export type ZodSchema = {
  def?: {
    type?: string;
    catchall?: { type?: string; def?: { type?: string } };
  };
};

function unknownKeysPolicy(schema: ZodSchema): UnknownKeysPolicy {
  const def = schema.def ?? {};
  if (def.type !== "object") {
    throw new Error(`expected object schema, got ${String(def.type)}`);
  }
  const catchallType = def.catchall?.type ?? def.catchall?.def?.type;
  if (catchallType === "never") {
    return "strict";
  }
  if (catchallType === "unknown") {
    return "passthrough";
  }
  return "strip";
}

function stripSchemaMeta(node: unknown): unknown {
  if (Array.isArray(node)) {
    return node.map(stripSchemaMeta);
  }
  if (!node || typeof node !== "object") {
    return node;
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key !== "$schema") {
      out[key] = stripSchemaMeta(value);
    }
  }
  return out;
}

function normalizeObjectNode(record: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { type: "object" };
  if (record.propertyNames) {
    out.propertyNames = normalizeTypeNode(record.propertyNames);
  }
  if ("additionalProperties" in record) {
    const additional = record.additionalProperties;
    out.additionalProperties =
      additional === true || additional === false ? additional : normalizeTypeNode(additional);
  }
  if (record.properties) {
    out.properties = Object.fromEntries(
      Object.entries(record.properties as Record<string, unknown>).map(([k, v]) => [
        k,
        normalizeTypeNode(v),
      ]),
    );
  }
  if (Array.isArray(record.required)) {
    out.required = [...(record.required as string[])].sort();
  }
  return out;
}

export function normalizeTypeNode(node: unknown): unknown {
  const stripped = stripSchemaMeta(node);
  if (!stripped || typeof stripped !== "object") {
    return stripped;
  }
  const record = stripped as Record<string, unknown>;
  if (Array.isArray(record.anyOf)) {
    return { anyOf: record.anyOf.map(normalizeTypeNode) };
  }
  if (record.type === "string" && Array.isArray(record.enum)) {
    return { type: "string", enum: [...(record.enum as string[])] };
  }
  if (record.type === "object") {
    return normalizeObjectNode(record);
  }
  return stripped;
}

export function objectDescriptorFromZod(schema: ZodSchema): ObjectShapeDescriptor {
  const json = normalizeTypeNode(z.toJSONSchema(schema)) as {
    properties?: Record<string, JsonTypeNode>;
    required?: string[];
  };
  return {
    properties: json.properties ?? {},
    required: [...(json.required ?? [])].sort(),
    unknownKeys: unknownKeysPolicy(schema),
  };
}

export function sortedObjectDescriptor(desc: ObjectShapeDescriptor): ObjectShapeDescriptor {
  return {
    properties: Object.fromEntries(
      Object.entries(desc.properties).map(([k, v]) => [k, normalizeTypeNode(v) as JsonTypeNode]),
    ),
    required: [...desc.required].sort(),
    unknownKeys: desc.unknownKeys,
  };
}

export { z };
