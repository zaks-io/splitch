interface ResponseWithJson {
  json(): Promise<unknown>;
}

/** The forced-call oracle shared by both Organization membership attack legs. */
export async function requireForbiddenResponse(response: ResponseWithJson): Promise<void> {
  const result = decodeTanStackEnvelope(await response.json());
  if (result.status !== 403) {
    throw new Error(`expected result status 403, received ${String(result.status)}`);
  }
  if (!isObject(result.error) || result.error.code !== "FORBIDDEN") {
    throw new Error('expected result error code "FORBIDDEN"');
  }
}

function decodeTanStackEnvelope(value: unknown): Record<string, unknown> {
  if (!isObject(value) || !Array.isArray(value.k) || !Array.isArray(value.v)) {
    throw new Error("expected a TanStack serialized result envelope");
  }
  const keys = value.k;
  const values = value.v;
  if (keys.length !== values.length || !keys.every((key) => typeof key === "string")) {
    throw new Error("expected matching TanStack result keys and values");
  }
  return Object.fromEntries(keys.map((key, index) => [key, values[index]]));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
