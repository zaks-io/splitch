import { schemaDefinitionIssues, validateJsonSchema } from "@splitch/contracts";
import type { DraftIssue, VariantValueType } from "#lib/flags/create-flag-model";

/**
 * The optional Flag-level JSON Schema drafted alongside an object-valued Flag.
 * Raw editor text parses here, in one place, so the schema the inline issues
 * were computed against is exactly the schema the create payload carries. The
 * rules themselves come from the contract's validator — the panel accepts a
 * schema iff the Worker would.
 */

/**
 * The Flag-level schema this draft submits. `type` always carries the editor's
 * value-type invariant; a drafted object schema refines it. Null when the text
 * fails to parse — `flagSchemaIssues` names why, and the payload builder
 * refuses rather than substituting.
 */
export function draftFlagSchema(
  valueType: VariantValueType,
  schemaText: string,
): Record<string, unknown> | null {
  if (valueType !== "object" || schemaText.trim() === "") return { type: valueType };
  const parsed = parseJsonRecord(schemaText);
  return parsed === null ? null : { ...parsed, type: "object" };
}

export function flagSchemaIssues(valueType: VariantValueType, schemaText: string): DraftIssue[] {
  if (valueType !== "object" || schemaText.trim() === "") return [];
  const parsed = parseJsonRecord(schemaText);
  if (parsed === null) {
    return [{ path: "schema", message: "Enter the schema as a JSON object." }];
  }
  if ("type" in parsed && parsed.type !== "object") {
    return [
      {
        path: "schema",
        message: 'Variant values are JSON objects, so the schema "type" must be "object".',
      },
    ];
  }
  return schemaDefinitionIssues({ ...parsed, type: "object" }, []).map((issue) => ({
    path: "schema",
    message: issue.path.length > 0 ? `${issue.path.join(".")}: ${issue.message}` : issue.message,
  }));
}

/** The schema drafted Variant values must pass, once the schema itself is valid. */
export function draftConformanceSchema(
  valueType: VariantValueType,
  schemaText: string,
): Record<string, unknown> | null {
  if (valueType !== "object" || schemaText.trim() === "") return null;
  if (flagSchemaIssues(valueType, schemaText).length > 0) return null;
  return draftFlagSchema(valueType, schemaText);
}

/** First violation of the drafted schema for one parsed Variant value, if any. */
export function variantSchemaIssue(schema: Record<string, unknown>, value: unknown): string | null {
  const violation = validateJsonSchema(schema, value, [])[0];
  if (!violation) return null;
  return violation.path.length > 0
    ? `Fails the Flag schema at ${violation.path.join(".")}: ${violation.message}.`
    : `Fails the Flag schema: ${violation.message}.`;
}

/** `null` means "not a JSON object" — arrays and scalars included. */
export function parseJsonRecord(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
