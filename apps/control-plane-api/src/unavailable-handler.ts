import type { HandlerArgs } from "@splitch/worker-runtime";
import { renderError } from "@splitch/worker-runtime";

/**
 * Preserve the shared HTTP/MCP error contract for routes whose backing workflow
 * is intentionally not available in this slice.
 */
export function unavailableControlPlaneOperation({ requestId }: HandlerArgs<unknown>): Response {
  return renderError(
    {
      code: "SERVICE_UNAVAILABLE",
      message: "operation is not available yet",
      details: { retryAfterMs: 1000 },
    },
    { requestId },
  );
}
