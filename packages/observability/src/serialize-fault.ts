/** Reduce thrown values without exposing Drizzle's bound query parameters. */
export function serializeFault(cause: unknown): string | undefined {
  if (cause === undefined) return undefined;
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = cause;
  // Error causes can be cyclic or getters that manufacture an endless chain.
  for (let depth = 0; depth < 32; depth++) {
    if (seen.has(current)) {
      parts.push("[circular error cause]");
      return parts.join("\nCaused by: ");
    }
    seen.add(current);
    try {
      if (!(current instanceof Error)) {
        parts.push(`non-Error thrown (${typeof current}): ${String(current)}`);
        return parts.join("\nCaused by: ");
      }
      parts.push(errorIdentity(current));
      current = current.cause;
      if (current === undefined) return parts.join("\nCaused by: ");
    } catch {
      // Reporting must remain total even for hostile stack/cause/toString getters.
      parts.push(`unrepresentable thrown value (${typeof current})`);
      return parts.join("\nCaused by: ");
    }
  }
  parts.push("[error cause chain truncated]");
  return parts.join("\nCaused by: ");
}

function errorIdentity(error: Error): string {
  const identity = `${error.name}: ${error.message}`;
  // Recognize the driver shape without importing a database driver into Workers.
  const isQueryError = "query" in error && typeof error.query === "string" && "params" in error;
  const safeIdentity = isQueryError ? `${error.name}: Failed query: ${error.query}` : identity;
  try {
    const stack = error.stack;
    if (stack) {
      if (!isQueryError) return stack;
      // Remove the complete message, including multiline params. Looking for the
      // first "at" line would mistake a bound value for a stack frame.
      if (stack.startsWith(identity)) return safeIdentity + stack.slice(identity.length);
    }
  } catch {
    // A broken stack getter must not discard the readable error identity.
  }
  return safeIdentity;
}
