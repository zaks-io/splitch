import type { z } from "zod";
import { buildExampleCandidate } from "./request-body-help-example";
import { describeObjectFields, unwrapField, unwrapToObject } from "./request-body-help-unwrap";

export const MCP_TOOL_EXAMPLE_PREFIX = "Example arguments:";

const CROCKFORD_ULID = "01J00000000000000000000000";

/** One worked arguments object that parses against the derived tool input. */
export function mcpToolArgumentsExample(
  schema: z.ZodTypeAny,
  operationId: string,
  bodySchema?: z.ZodTypeAny,
): Record<string, unknown> {
  const objectSchema = unwrapToObject(schema);
  if (!objectSchema) {
    throw new Error(
      `mcp-tool-description: route "${operationId}" cannot derive an arguments example from a non-object input`,
    );
  }
  const fields = describeObjectFields(objectSchema);
  // Path params are required, so a flattened schema would drop optional body
  // fields. Build the body example first (all-optional PATCH bodies include a
  // writable field), then overlay path/query.
  const bodyObject = bodySchema ? unwrapToObject(bodySchema) : undefined;
  const bodyExample = bodyObject
    ? buildExampleCandidate(bodyObject, describeObjectFields(bodyObject))
    : {};
  const example = repairExample(objectSchema, {
    ...buildExampleCandidate(objectSchema, fields),
    ...bodyExample,
  });
  const parsed = objectSchema.safeParse(example);
  if (parsed.success) return example;
  const issue = parsed.error.issues[0];
  throw new Error(
    `mcp-tool-description: route "${operationId}" arguments example failed validation` +
      (issue ? ` at ${issue.path.join(".") || "(root)"}: ${issue.message}` : ""),
  );
}

export function renderMcpToolExample(example: Record<string, unknown>): string {
  return `${MCP_TOOL_EXAMPLE_PREFIX} ${JSON.stringify(example)}`;
}

function repairExample(
  schema: z.ZodObject,
  example: Record<string, unknown>,
): Record<string, unknown> {
  const repaired = { ...example };
  for (const [name, fieldSchema] of Object.entries(schema.shape)) {
    const value = repaired[name];
    if (typeof value !== "string") continue;
    const { inner } = unwrapField(fieldSchema as z.ZodTypeAny);
    if (inner.safeParse(value).success) continue;
    repaired[name] = matchingString(name, inner);
  }
  return repaired;
}

function matchingString(fieldName: string, schema: z.ZodTypeAny): string {
  const message = schema.safeParse("").success
    ? ""
    : (schema.safeParse("_").error?.issues[0]?.message ??
      schema.safeParse("x").error?.issues[0]?.message ??
      "");
  if (fieldName === "id" || message.includes("apr_")) return `apr_${CROCKFORD_ULID}`;
  if (message.includes("rev_")) return `rev_${CROCKFORD_ULID}`;
  if (message.includes("separated by single hyphens")) return slugFrom(fieldName);
  if (message.includes("separated by single underscores")) return snakeFrom(fieldName);
  if (fieldName.endsWith("Key") && fieldName !== "idempotency_key") return slugFrom(fieldName);
  return snakeFrom(fieldName) || "value";
}

function slugFrom(fieldName: string): string {
  const slug = snakeFrom(fieldName).replaceAll("_", "-");
  return slug.length >= 2 ? slug : `${slug}x`;
}

function snakeFrom(fieldName: string): string {
  return fieldName
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}
