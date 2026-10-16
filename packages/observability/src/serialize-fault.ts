import { d1Diagnostic } from "./fault-d1-diagnostics.js";

const MAX_NODES = 32;
const MAX_BYTES = 8 * 1024;
type Field = { ok: true; value: unknown } | { ok: false };

/**
 * Deny-by-default, never-throw Worker diagnostics. Emit only validated error names,
 * Drizzle placeholder SQL (2,000 characters), allowlisted D1 tokens/static phrases
 * and SQLite result-code names, header-verified stack frames, and fixed markers.
 * All other messages, including top-level messages and parser excerpts, are withheld.
 * Strip the complete exact name/message header before selecting frame lines; custom,
 * mutated or unreadable headers cannot contribute frames. Isolate every field read
 * so a hostile getter cannot discard another field's SQL or the rest of the graph.
 * Traverse cause, then aggregate members, depth-first with cycle protection and one
 * 32-node budget. Keep earlier diagnostics and an omitted count within 8 KB of UTF-8.
 * Parameter values are never read or redacted: no free message text is emitted, so
 * value matching is unnecessary and cannot leak truncated excerpts or missed nodes.
 */
export function serializeFault(cause: unknown): string | undefined {
  try {
    if (cause === undefined) return undefined;
    return serializeGraph(cause);
  } catch (failure) {
    return `[fault serialization failed: ${failureName(failure)}]`;
  }
}

function readField(value: object, field: string): Field {
  try {
    return { ok: true, value: Reflect.get(value, field) };
  } catch {
    return { ok: false };
  }
}

function serializeGraph(root: unknown): string {
  const seen = new Set<unknown>();
  const output: string[] = [];
  let visited = 0;
  let omitted = 0;

  function visit(value: unknown, relation: string): void {
    if (visited >= MAX_NODES) {
      omitted++;
      return;
    }
    visited++;
    if (seen.has(value)) {
      output.push(`${relation}[circular error cause]`);
      return;
    }
    seen.add(value);
    if ((typeof value !== "object" || value === null) && typeof value !== "function") {
      output.push(`${relation}Error: [message withheld]`);
      return;
    }
    output.push(relation + nodeDiagnostic(value));
    visitCause(value);
    visitMembers(value);
  }

  function visitCause(value: object): void {
    const cause = readField(value, "cause");
    if (!cause.ok) output.push("\ncause: [unreadable]");
    else if (cause.value !== undefined) visit(cause.value, "\nCaused by: ");
  }

  function visitMembers(value: object): void {
    const errors = readMembers(value);
    if (!errors.ok) {
      output.push("\nerrors: [unreadable]");
      return;
    }
    if (!errors.value) return;
    const { members, length } = errors.value;
    // Do not read omitted members or invoke a user-supplied iterator.
    for (let index = 0; index < length; index++) {
      if (visited >= MAX_NODES) {
        omitted += length - index;
        break;
      }
      const member = readField(members, String(index));
      visitMember(member);
    }
  }

  function visitMember(member: Field): void {
    if (member.ok) visit(member.value, "\nAggregate member: ");
    else {
      visited++;
      output.push("\nAggregate member: [unreadable]");
    }
  }

  visit(root, "");
  return boundedOutput(output.join(""), omitted ? `\n[${omitted} more errors omitted]` : "");
}

function readMembers(
  error: object,
): { ok: true; value?: { members: unknown[]; length: number } } | { ok: false } {
  try {
    const members: unknown = Reflect.get(error, "errors");
    if (!Array.isArray(members)) return { ok: true };
    const length: unknown = members.length;
    return typeof length === "number" && Number.isSafeInteger(length) && length >= 0
      ? { ok: true, value: { members, length } }
      : { ok: false };
  } catch {
    return { ok: false };
  }
}

function nodeDiagnostic(error: object): string {
  const name = readField(error, "name");
  const message = readField(error, "message");
  const query = readQuery(error);
  const stack = readField(error, "stack");
  const safeName =
    name.ok && typeof name.value === "string" && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name.value)
      ? name.value
      : "Error";
  const identity =
    query.ok && typeof query.value === "string"
      ? `Failed query: ${query.value.slice(0, 2000)}`
      : message.ok && typeof message.value === "string"
        ? (d1Diagnostic(message.value) ?? "[message withheld]")
        : "[message withheld]";
  const unreadable = [
    ["name", name],
    ["message", message],
    ["query", query],
    ["stack", stack],
  ] as const;
  return (
    `${safeName}: ${identity}` +
    unreadable
      .filter(([, field]) => !field.ok)
      .map(([field]) => `\n${field}: [unreadable]`)
      .join("") +
    verifiedFrames(name, message, stack)
  );
}

function readQuery(error: object): Field {
  try {
    // Drizzle's structural identity avoids importing its runtime into Workers.
    // Presence is sufficient; parameter values and their getters are never read.
    return { ok: true, value: "params" in error ? Reflect.get(error, "query") : undefined };
  } catch {
    return { ok: false };
  }
}

function verifiedFrames(name: Field, message: Field, stack: Field): string {
  if (
    !name.ok ||
    !message.ok ||
    !stack.ok ||
    typeof name.value !== "string" ||
    typeof message.value !== "string" ||
    typeof stack.value !== "string"
  )
    return "\n[stack withheld]";
  const header = message.value ? `${name.value}: ${message.value}\n` : `${name.value}\n`;
  if (!stack.value.startsWith(header)) return "\n[stack withheld]";
  const frames = stack.value
    .slice(header.length)
    .split("\n")
    .filter((line) => /^\s+at /.test(line));
  return frames.length ? `\n${frames.join("\n")}` : "";
}

function boundedOutput(text: string, suffix: string): string {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(text);
  if (bytes.length + encoder.encode(suffix).length <= MAX_BYTES) return text + suffix;
  const ending = `\n[fault output truncated]${suffix}`;
  const budget = MAX_BYTES - encoder.encode(ending).length;
  return new TextDecoder().decode(bytes.subarray(0, budget), { stream: true }) + ending;
}

function failureName(failure: unknown): string {
  try {
    for (const kind of [
      EvalError,
      RangeError,
      ReferenceError,
      SyntaxError,
      TypeError,
      URIError,
      AggregateError,
    ]) {
      if (failure instanceof kind) return kind.name;
    }
  } catch {
    /* A hostile thrown Proxy cannot escape the fallback. */
  }
  return "Error";
}
