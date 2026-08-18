interface ResponseWithJson {
  json(): Promise<unknown>;
}

/** The forced-call oracle shared by both Organization membership attack legs. */
export async function requireForbiddenResponse(response: ResponseWithJson): Promise<void> {
  const result = decodeTanStackEnvelope(await response.json());
  if (result.ok !== false) {
    throw new Error("expected a refused TanStack server-function result");
  }
  if (result.status !== 403) {
    throw new Error(`expected result status 403, received ${String(result.status)}`);
  }
  if (!isObject(result.error) || result.error.code !== "FORBIDDEN") {
    throw new Error('expected result error code "FORBIDDEN"');
  }
}

function decodeTanStackEnvelope(value: unknown): Record<string, unknown> {
  const resultNode = objectNodeProperty(value, "result");
  if (resultNode === undefined) {
    throw new Error("expected a TanStack serialized result envelope");
  }
  return decodeObjectNode(resultNode);
}

function decodeObjectNode(value: unknown): Record<string, unknown> {
  if (!isObject(value) || value.t !== 10 || !isObject(value.p)) {
    throw new Error("expected a TanStack serialized object node");
  }
  const keys = value.p.k;
  const values = value.p.v;
  if (
    !Array.isArray(keys) ||
    !keys.every((key) => typeof key === "string") ||
    !Array.isArray(values) ||
    keys.length !== values.length
  ) {
    throw new Error("expected matching TanStack object keys and values");
  }
  return Object.fromEntries(keys.map((key, index) => [key, decodeNode(values[index])]));
}

function objectNodeProperty(value: unknown, property: string): unknown {
  if (!isObject(value) || value.t !== 10 || !isObject(value.p)) return undefined;
  const keys = value.p.k;
  const values = value.p.v;
  if (!Array.isArray(keys) || !Array.isArray(values)) return undefined;
  const index = keys.indexOf(property);
  return index < 0 ? undefined : values[index];
}

function decodeNode(value: unknown): unknown {
  if (!isObject(value)) throw new Error("expected a TanStack serialized node");
  if (value.t === 10) return decodeObjectNode(value);
  if (value.t === 0 && (typeof value.s === "number" || typeof value.s === "string")) {
    return Number(value.s);
  }
  if (value.t === 1 && typeof value.s === "string") return value.s;
  if (value.t === 2 && typeof value.s === "number") return decodeConstant(value.s);
  throw new Error("unsupported TanStack serialized node");
}

function decodeConstant(value: number): boolean | null | undefined {
  if (value === 0) return null;
  if (value === 1) return undefined;
  if (value === 2) return true;
  if (value === 3) return false;
  throw new Error("unsupported TanStack serialized constant");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
