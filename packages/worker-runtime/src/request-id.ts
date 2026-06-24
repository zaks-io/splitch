const REQUEST_ID_HEADER = "x-request-id";

/**
 * Use a caller-supplied request ID when present (trusted only for correlation,
 * never for authz), else mint one. crypto.randomUUID is available in Workers and
 * Node 18+.
 */
export function resolveRequestId(request: Request): string {
  const incoming = request.headers.get(REQUEST_ID_HEADER);
  if (incoming && incoming.length > 0 && incoming.length <= 200) {
    return incoming;
  }
  return crypto.randomUUID();
}
