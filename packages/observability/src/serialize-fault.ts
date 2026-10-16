/** Reduce thrown values without exposing Drizzle's bound query parameters. */
export function serializeFault(cause: unknown): string | undefined {
  if (cause === undefined) return undefined;
  const parts: string[] = [];
  const seen = new Set<unknown>();
  const replacements = new Map<string, string>();
  let remaining = 32;
  let truncated = false;

  function visit(current: unknown, relation: string): void {
    if (remaining-- <= 0) {
      truncated = true;
      return;
    }
    const append = (text: string) => parts.push(`${relation}${text}`);
    if (seen.has(current)) {
      append("[circular error cause]");
      return;
    }
    seen.add(current);
    try {
      if (!(current instanceof Error)) {
        append(`non-Error thrown (${typeof current}): ${String(current)}`);
        return;
      }
      append(errorIdentity(current, replacements));
      visitChildren(current);
    } catch {
      // Reporting must remain total even for hostile stack/cause/toString getters.
      append(`unrepresentable thrown value (${typeof current})`);
    }
  }

  function visitChildren(error: Error): void {
    const nested = error.cause;
    if (nested !== undefined) visit(nested, "\nCaused by: ");
    if (!(error instanceof AggregateError)) return;
    for (const member of error.errors) {
      if (truncated) break;
      visit(member, "\nAggregate member: ");
    }
  }

  visit(cause, "");
  // Unvisited members may contain parameters echoed by an already visited error.
  if (truncated) return "[error cause chain truncated]";
  const output = parts.join("");
  const patterns = [...replacements.keys()].filter(Boolean).sort((a, b) => b.length - a.length);
  if (patterns.length === 0) return output;
  const pattern = new RegExp(
    patterns.map((text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"),
    "g",
  );
  // One pass prevents parameter matches from altering the SQL inserted in place
  // of a complete Drizzle message (for example a parameter with value `1`).
  return output.replace(pattern, (match) => replacements.get(match) ?? "");
}

function errorIdentity(error: Error, replacements: Map<string, string>): string {
  const isQueryError = registerQueryRedactions(error, replacements);
  const identity = `${error.name}: ${error.message}`;
  try {
    const stack = error.stack;
    if (stack && (!isQueryError || stack.includes(error.message))) return stack;
  } catch {
    // A broken stack getter must not discard the readable error identity.
  }
  return identity;
}

function registerQueryRedactions(error: Error, replacements: Map<string, string>): boolean {
  // Gather parameters before redacting output: ancestors, siblings and database
  // causes can repeat a query message or parameter. Avoid a Worker driver import.
  if (!("query" in error && typeof error.query === "string" && "params" in error)) return false;
  if (!Array.isArray(error.params)) throw new Error("Unreadable query parameters");
  for (const value of error.params) {
    const parameter = String(value);
    if (parameter) replacements.set(parameter, "[REDACTED query parameter]");
  }
  replacements.set(error.message, `Failed query: ${error.query}`);
  return true;
}
