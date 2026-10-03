import type { z } from "zod";
import {
  unwrapField,
  unwrapToObject,
  zodDef,
  zodDefType,
  zodLiteralValues,
  zodOptions,
} from "./request-body-help-unwrap";

export interface McpToolFormatNote {
  readonly name: string;
  readonly text: string;
}

/** Top-level id, timestamp, and enum formats an agent must see before calling. */
export function mcpToolFormatNotes(schema: z.ZodTypeAny): readonly McpToolFormatNote[] {
  const objectSchema = unwrapToObject(schema);
  if (!objectSchema) return [];
  const notes: McpToolFormatNote[] = [];
  for (const [name, fieldSchema] of Object.entries(objectSchema.shape)) {
    const note = formatNote(name, fieldSchema as z.ZodTypeAny);
    if (note) notes.push(note);
  }
  return notes;
}

export function renderMcpToolFormats(notes: readonly McpToolFormatNote[]): string {
  if (notes.length === 0) return "Formats: no id, timestamp, or enum arguments.";
  return `Formats: ${notes.map((note) => `${note.name}: ${note.text}`).join(" ")}`;
}

function formatNote(name: string, schema: z.ZodTypeAny): McpToolFormatNote | undefined {
  const { inner, required } = unwrapField(schema);
  const requirement = required ? "required" : "optional";
  const described = inner.description?.trim();
  const enumValues = enumOrLiteralValues(inner);
  const timestamp = isTimestamp(inner);
  const idLike = isIdLike(name);
  if (!described && enumValues.length === 0 && !timestamp && !idLike) return undefined;
  const parts = [`${requirement}`];
  if (described) parts.push(described);
  if (timestamp && !described?.includes("ISO-8601") && !described?.includes("ISO 8601")) {
    parts.push("ISO-8601 instant with offset.");
  }
  if (enumValues.length > 0) {
    parts.push(`one of ${enumValues.map((value) => JSON.stringify(value)).join(", ")}.`);
  }
  if (idLike && !described) parts.push("canonical id or human-readable selector.");
  return { name, text: parts.join(" ") };
}

function isIdLike(name: string): boolean {
  return name === "id" || name.endsWith("Id") || name.endsWith("Ids") || name.endsWith("Key");
}

function isTimestamp(schema: z.ZodTypeAny): boolean {
  const format = zodDef(schema).format;
  return format === "datetime" || format === "iso_datetime";
}

function enumOrLiteralValues(schema: z.ZodTypeAny): unknown[] {
  const type = zodDefType(schema);
  if (type === "enum") return [...((schema as z.ZodEnum).options as readonly unknown[])];
  if (type === "literal") return zodLiteralValues(schema);
  if (type === "union" || type === "xor") {
    const values: unknown[] = [];
    for (const option of zodOptions(schema)) {
      values.push(...enumOrLiteralValues(unwrapField(option).inner));
    }
    return values;
  }
  return [];
}
