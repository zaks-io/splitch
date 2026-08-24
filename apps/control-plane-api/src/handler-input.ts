export function pathParam(input: unknown, key: string): string {
  const params = (input as { params?: Record<string, unknown> } | null)?.params;
  const value = params?.[key];
  if (typeof value !== "string") {
    throw new Error(`control-plane-api: validated input is missing path param "${key}"`);
  }
  return value;
}

export function objectBody(input: unknown): Record<string, unknown> {
  const value = (input as { body?: unknown } | null)?.body;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("control-plane-api: validated input is missing object body");
  }
  return value as Record<string, unknown>;
}

export function optionalQueryParam(input: unknown, key: string): string | undefined {
  const query = (input as { query?: Record<string, unknown> } | null)?.query;
  const value = query?.[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new Error(`control-plane-api: validated input has invalid query param "${key}"`);
  }
  return value;
}

/**
 * Read optional boolean query flags after Zod has coerced query/MCP input.
 * Absent flags are false.
 */
export function queryFlags(input: unknown): { dryRun: boolean; force: boolean } {
  const query = (input as { query?: Record<string, unknown> } | null)?.query ?? {};
  return {
    dryRun: query.dryRun === true,
    force: query.force === true,
  };
}
