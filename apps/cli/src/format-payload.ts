/**
 * The one human renderer for CLI results.
 *
 * `--json` writes the payload verbatim for `jq`; without it every command
 * prints through here, so an operator never reads a raw `JSON.stringify`
 * dump and the shape of one command's output predicts the next one's.
 * Commands with a domain-specific layout (Flag reads, Environment Policy)
 * build on the primitives exported here rather than inventing a second
 * table or label style.
 */

/** Words that are wrong in Title Case, keyed by their lowercased form. */
const LABEL_WORDS: Readonly<Record<string, string>> = {
  api: "API",
  bh: "BH",
  ci: "CI",
  cli: "CLI",
  cuped: "CUPED",
  id: "ID",
  ids: "IDs",
  ip: "IP",
  json: "JSON",
  kv: "KV",
  ms: "(ms)",
  pct: "(%)",
  rps: "RPS",
  sdk: "SDK",
  sdks: "SDKs",
  sha: "SHA",
  srm: "SRM",
  ttl: "TTL",
  url: "URL",
  urls: "URLs",
  uuid: "UUID",
};

/** `defaultVariantId` -> `Default Variant ID`; `p_value` -> `P Value`. */
export function humanizeLabel(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[\s_-]+/)
    .filter((word) => word.length > 0)
    .map((word) => LABEL_WORDS[word.toLowerCase()] ?? `${word[0]?.toUpperCase()}${word.slice(1)}`)
    .join(" ");
}

const SCALAR_TYPES = new Set(["string", "number", "boolean"]);

/**
 * A comma-joined line only reads as a list while the items are single tokens
 * (Variant names, change types). Once an item is a phrase or a whole command
 * the commas stop marking the boundaries, so those get one line each.
 */
const INLINE_LIST_ITEM = /^[^\s,]+$/;

function isScalar(value: unknown): value is string | number | boolean | null {
  return value === null || SCALAR_TYPES.has(typeof value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The shared list envelope (`wire-envelopes-core.ts`). `readTruncated` is the
 * discriminator rather than `items` alone: a resource may legitimately carry an
 * `items` array of its own (App attention rollup) that is not a bounded read.
 */
interface ListEnvelope {
  readonly items: readonly unknown[];
  readonly readLimit: number;
  readonly readTruncated: boolean;
}

export function isListEnvelope(value: unknown): value is ListEnvelope {
  return (
    isRecord(value) &&
    Array.isArray(value.items) &&
    typeof value.readTruncated === "boolean" &&
    typeof value.readLimit === "number"
  );
}

/** `null` in a labelled line is data the server sent, not a missing field. */
function fieldValue(value: string | number | boolean | null): string {
  if (value === null) return "(none)";
  if (value === "") return "(empty)";
  return String(value);
}

/** Table cells stay sparse: a column of `(none)` reads as noise, not as data. */
export function cellValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (SCALAR_TYPES.has(typeof value)) return String(value);
  return JSON.stringify(value);
}

export function formatTable(
  headers: readonly string[],
  rows: readonly (readonly string[])[],
): string {
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => row[index]?.length ?? 0)),
  );
  return [headers, ...rows]
    .map((row) =>
      row
        .map((cell, index) => cell.padEnd(widths[index] ?? 0))
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}

function indent(block: string, marker = "  "): string {
  return block
    .split("\n")
    .map((line, index) => {
      if (index === 0) return `${marker}${line}`;
      return line.length > 0 ? `  ${line}` : line;
    })
    .join("\n");
}

/**
 * A field block already separates its own nested sections with blank lines, so
 * blank lines alone cannot mark where one item of a collection ends and the
 * next begins. The leading marker is the only thing that does.
 */
function bulleted(block: string): string {
  return indent(block, "- ");
}

/**
 * A bounded read that omitted rows is not a complete answer, and nothing else
 * in the human output says so. One wording for every list: the read order is
 * per-resource, so this claims only what is true of all of them.
 */
export function truncationNotice(readLimit: number, noun: string): string {
  return `Truncated: more than ${readLimit} ${noun} exist; ${readLimit} are shown. Narrow the read before treating this as the full set.`;
}

/** Column order is first-seen across the collection, so sparse rows still align. */
function collectionColumns(items: readonly Record<string, unknown>[]): string[] {
  const columns: string[] = [];
  for (const item of items) {
    for (const key of Object.keys(item)) {
      if (!columns.includes(key)) columns.push(key);
    }
  }
  return columns;
}

/**
 * A table only when every row is flat. One nested object in a cell would push
 * the JSON for it into a padded column and blow the line width past anything
 * readable, so those collections render as stacked blocks instead.
 */
function formatCollection(items: readonly unknown[], noun: string): string {
  if (items.length === 0) return `No ${noun} found.`;
  const records = items.filter(isRecord);
  if (records.length !== items.length) {
    return items.map((item) => `- ${cellValue(item)}`).join("\n");
  }
  if (records.every((item) => Object.values(item).every(isScalar))) {
    const columns = collectionColumns(records);
    return formatTable(
      columns.map((column) => humanizeLabel(column).toUpperCase()),
      records.map((item) => columns.map((column) => cellValue(item[column]))),
    );
  }
  return records.map((item) => bulleted(formatRecord(item))).join("\n\n");
}

function formatListEnvelope(envelope: ListEnvelope, noun: string): string {
  const body = formatCollection(envelope.items, noun);
  return envelope.readTruncated ? `${body}\n\n${truncationNotice(envelope.readLimit, noun)}` : body;
}

interface RecordParts {
  readonly lines: string[];
  readonly sections: string[];
}

function appendArrayField(parts: RecordParts, label: string, value: readonly unknown[]): void {
  if (value.length === 0) {
    parts.lines.push(`${label}: (none)`);
    return;
  }
  if (!value.every(isScalar)) {
    parts.sections.push(`${label}\n${formatCollection(value, label)}`);
    return;
  }
  const rendered = value.map((item) => cellValue(item));
  if (rendered.every((item) => INLINE_LIST_ITEM.test(item))) {
    parts.lines.push(`${label}: ${rendered.join(", ")}`);
    return;
  }
  parts.sections.push(`${label}\n${rendered.map((item) => `- ${item}`).join("\n")}`);
}

function appendField(parts: RecordParts, key: string, value: unknown): void {
  const label = humanizeLabel(key);
  if (isScalar(value)) {
    parts.lines.push(`${label}: ${fieldValue(value)}`);
    return;
  }
  if (Array.isArray(value)) {
    appendArrayField(parts, label, value);
    return;
  }
  if (!isRecord(value)) return;
  if (isListEnvelope(value)) {
    parts.sections.push(`${label}\n${formatListEnvelope(value, label)}`);
    return;
  }
  if (Object.keys(value).length === 0) {
    parts.lines.push(`${label}: (none)`);
    return;
  }
  parts.sections.push(`${label}\n${indent(formatRecord(value))}`);
}

/**
 * Scalars first, then the nested sections, each under its own heading. The
 * split is what keeps a resource's identity (id, key, name, timestamps)
 * visible without scrolling past whatever collection it carries.
 */
function formatRecord(record: Record<string, unknown>): string {
  const parts: RecordParts = { lines: [], sections: [] };
  for (const [key, value] of Object.entries(record)) {
    if (value === undefined) continue;
    appendField(parts, key, value);
  }
  return [parts.lines.join("\n"), ...parts.sections].filter((part) => part.length > 0).join("\n\n");
}

/**
 * @param noun Title-cased plural for the rows this payload carries, used by the
 *   empty and truncated notices ("No Flags found."). Callers derive it from the
 *   command's resource group so the notice names what was actually read.
 */
export function formatPayload(payload: unknown, noun = "Results"): string {
  if (payload === undefined) return "";
  if (typeof payload === "string") return payload;
  if (isScalar(payload)) return fieldValue(payload);
  if (Array.isArray(payload)) return formatCollection(payload, noun);
  if (isListEnvelope(payload)) return formatListEnvelope(payload, noun);
  if (isRecord(payload)) return formatRecord(payload);
  return JSON.stringify(payload);
}
