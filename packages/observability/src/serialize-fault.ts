const MAX_NODES = 32;
const MAX_BYTES = 8 * 1024;

interface QueryFault extends Error {
  query: string;
  params: unknown[];
}

interface FaultNode {
  value: unknown;
  relation: string;
  identity: string;
  stack: string;
  children: FaultNode[];
}

/**
 * Never-throw Worker diagnostics: at most 32 nodes and 8 KB of UTF-8 output.
 * Rebuild Drizzle messages from SQL only; retain D1_ and top-level messages
 * (500 characters), except SyntaxError. Withhold every other nested message.
 * Emit only stack-frame lines, traverse causes and aggregate members with cycle
 * protection, and retain earlier diagnostics with an omitted count on overflow.
 * Read query parameters only for defense in depth: remove their exact string
 * values with string-only replaceAll, including before extracting stack frames.
 * Internal failures return a fixed diagnostic containing only the error type.
 */
export function serializeFault(cause: unknown): string | undefined {
  try {
    if (cause === undefined) return undefined;
    return serializeGraph(cause);
  } catch (failure) {
    return `[fault serialization failed: ${failureName(failure)}]`;
  }
}

function serializeGraph(cause: unknown): string {
  const root = faultNode(cause, "");
  const nodes = [root];
  const seen = new Set<unknown>();
  const queries: QueryFault[] = [];
  let omitted = 0;

  function enqueue(value: unknown, relation: string, parent: FaultNode): void {
    if (nodes.length >= MAX_NODES) {
      omitted++;
      return;
    }
    const node = faultNode(value, relation);
    parent.children.push(node);
    nodes.push(node);
  }

  function visit(node: FaultNode): void {
    if (seen.has(node.value)) {
      node.identity = "[circular error cause]";
      return;
    }
    seen.add(node.value);
    readIdentity(node, node === root, queries);
    if (node.value instanceof Error) visitChildren(node.value, node);
  }

  function visitChildren(error: Error, node: FaultNode): void {
    const nested = error.cause;
    if (nested !== undefined) enqueue(nested, "\nCaused by: ", node);
    if (!(error instanceof AggregateError)) return;
    const members: unknown[] = error.errors;
    if (!Array.isArray(members)) throw new TypeError("Unreadable aggregate members");
    const available = MAX_NODES - nodes.length;
    for (const member of members.slice(0, available)) {
      enqueue(member, "\nAggregate member: ", node);
    }
    omitted += Math.max(0, members.length - available);
  }

  // Reserve the node budget breadth-first, then render causes beside their
  // parents so an aggregate's first SQL and D1 cause remain useful within 8 KB.
  for (const node of nodes) visit(node);
  const parameters = queryParameters(queries);
  const text = redact(renderNode(root, parameters), parameters);
  const suffix = omitted > 0 ? `\n[${omitted} more errors omitted]` : "";
  return boundedOutput(text, redact(suffix, parameters));
}

function queryParameters(queries: QueryFault[]): Set<string> {
  const parameters = new Set<string>();
  for (const query of queries) {
    for (const value of query.params) {
      const parameter = String(value);
      if (parameter) parameters.add(parameter);
    }
  }
  return parameters;
}

function faultNode(value: unknown, relation: string): FaultNode {
  return { value, relation, identity: "", stack: "", children: [] };
}

function readIdentity(node: FaultNode, topLevel: boolean, queries: QueryFault[]): void {
  const error = node.value;
  if (!(error instanceof Error)) {
    const message = topLevel ? String(error).slice(0, 500) : "[message withheld]";
    node.identity = `non-Error thrown (${typeof error}): ${message}`;
    return;
  }
  let message: string;
  if (isQueryFault(error)) {
    message = `Failed query: ${error.query}`;
    queries.push(error);
  } else {
    message = permittedMessage(error, topLevel);
  }
  node.identity = `${error.name}: ${message}`;
  node.stack = error.stack ?? "";
}

function isQueryFault(error: Error): error is QueryFault {
  return "query" in error && typeof error.query === "string" && "params" in error;
}

function permittedMessage(error: Error, topLevel: boolean): string {
  if (error instanceof SyntaxError) return "[message withheld]";
  const message = error.message;
  return topLevel || message.startsWith("D1_") ? message.slice(0, 500) : "[message withheld]";
}

function renderNode(node: FaultNode, parameters: Set<string>): string {
  const frames = redact(node.stack, parameters)
    .split("\n")
    .filter((line) => /^\s+at /.test(line));
  return (
    node.relation +
    [node.identity, ...frames].join("\n") +
    node.children.map((child) => renderNode(child, parameters)).join("")
  );
}

function redact(text: string, parameters: Set<string>): string {
  for (const parameter of parameters) text = text.replaceAll(parameter, "");
  return text;
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
    // Even a hostile thrown Proxy must not escape the fallback.
  }
  return "Error";
}
