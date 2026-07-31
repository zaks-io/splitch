/**
 * Shared harness for the two idempotency-header contract tests. They probe
 * different clients (the typed route groups vs. the MCP adapter) over different
 * slices of `routeRegistry`, but both assert on the OUTBOUND request and never on
 * a response, so the capture mechanism itself must not exist twice.
 */

/** Thrown once the outbound Request is captured, so no probe ever reaches the network. */
class RequestCaptured extends Error {}

/**
 * Run `probe` with a fetch that records the first outbound Request and aborts.
 * Errors other than the capture sentinel propagate — a probe asserting that a
 * client refuses to send at all depends on that.
 */
export async function captureOutboundRequest(
  probe: (fetchImpl: typeof fetch) => Promise<unknown>,
): Promise<Request> {
  const requests: Request[] = [];
  const capturingFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push(new Request(input as RequestInfo, init));
    throw new RequestCaptured("captured");
  }) as typeof fetch;

  await probe(capturingFetch).catch((error: unknown) => {
    if (!(error instanceof RequestCaptured)) throw error;
  });

  const request = requests[0];
  if (!request) throw new Error("the client issued no HTTP request");
  return request;
}
