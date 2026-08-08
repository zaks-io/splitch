interface ResponseWithJson {
  status(): number;
  json(): Promise<unknown>;
}

/** The forced-call oracle shared by both Organization membership attack legs. */
export async function requireForbiddenResponse(response: ResponseWithJson): Promise<void> {
  const status = response.status();
  const body = await response.json();
  if (status !== 403) {
    throw new Error(`expected HTTP 403, received ${status}`);
  }
  if (!isObject(body) || body.code !== "FORBIDDEN") {
    throw new Error('expected response code "FORBIDDEN"');
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
