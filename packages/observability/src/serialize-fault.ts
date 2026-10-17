import { d1Diagnostic } from "./fault-d1-diagnostics.js";

const MAX_NODES = 32;
const MAX_BYTES = 8 * 1024;
type Field = { ok: true; value: unknown } | { ok: false };

/**
 * Deny-by-default, never-throw Worker diagnostics. Emit only validated error names,
 * Drizzle placeholder SQL (2,000 characters), allowlisted D1 tokens/static phrases
 * and SQLite result-code names, header-verified stack frames, and fixed markers.
 * All other messages, including top-level messages and parser excerpts, are withheld.
 * SQL requires Object.prototype.toString.call(error) === "[object Error]", an
 * isolated constructor.name of DrizzleQueryError, an own string query, and an own
 * array params. Only engine Errors with a nonempty, exact name/message header
 * contribute the contiguous frame block immediately after that header. Other stacks,
 * including empty-message, mutated or unreadable headers, are withheld. Workerd
 * disallows eval and new Function, so eval-source frames cannot occur in production.
 * The repository guard forbids writing .stack or Error.prepareStackTrace in source;
 * that guard prevents deliberately placing data in frames, not this serializer.
 * Isolate every field read so a hostile getter cannot discard another field's SQL
 * or the rest of the graph.
 * Traverse cause, then aggregate members, depth-first with cycle protection and one
 * 32-node budget. Keep earlier diagnostics and an omitted count within 8 KB of UTF-8.
 * Parameter entries are never read or redacted: no free message text is emitted, so
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
      output.push(`${relation}Error: [message withheld]\n[stack withheld]`);
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
  const engineError = isEngineError(error);
  const name = readField(error, "name");
  const message = readField(error, "message");
  const constructorName = engineError
    ? readConstructorName(error)
    : { ok: true as const, value: undefined };
  const query = readQuery(error, engineError, constructorName);
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
    ["constructor.name", constructorName],
    ["query", query],
    ["stack", stack],
  ] as const;
  return (
    `${safeName}: ${identity}` +
    unreadable
      .filter(([, field]) => !field.ok)
      .map(([field]) => `\n${field}: [unreadable]`)
      .join("") +
    verifiedFrames(engineError, name, message, stack)
  );
}

function isEngineError(error: object): boolean {
  try {
    return Object.prototype.toString.call(error) === "[object Error]";
  } catch {
    return false;
  }
}

function readConstructorName(error: object): Field {
  const errorConstructor = readField(error, "constructor");
  if (!errorConstructor.ok) return errorConstructor;
  return errorConstructor.value !== null &&
    (typeof errorConstructor.value === "object" || typeof errorConstructor.value === "function")
    ? readField(errorConstructor.value, "name")
    : { ok: true, value: undefined };
}

function readQuery(error: object, engineError: boolean, constructorName: Field): Field {
  if (!engineError || !constructorName.ok || constructorName.value !== "DrizzleQueryError")
    return { ok: true, value: undefined };
  try {
    // Verify Drizzle's own data shape without importing its runtime or reading a
    // parameter entry. Accessors cannot establish the required params array.
    const params = Object.getOwnPropertyDescriptor(error, "params");
    return {
      ok: true,
      value:
        params && "value" in params && Array.isArray(params.value) && Object.hasOwn(error, "query")
          ? Reflect.get(error, "query")
          : undefined,
    };
  } catch {
    return { ok: false };
  }
}

function verifiedFrames(engineError: boolean, name: Field, message: Field, stack: Field): string {
  if (
    !engineError ||
    !name.ok ||
    !message.ok ||
    !stack.ok ||
    typeof name.value !== "string" ||
    typeof message.value !== "string" ||
    !message.value ||
    typeof stack.value !== "string"
  )
    return "\n[stack withheld]";
  const header = `${name.value}: ${message.value}\n`;
  if (!stack.value.startsWith(header)) return "\n[stack withheld]";
  const frames: string[] = [];
  for (const line of stack.value.slice(header.length).split("\n")) {
    if (!/^\s+at /.test(line)) break;
    frames.push(line);
  }
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
