import { createWorkerObservability } from "@splitch/observability/worker";
import type { Observability } from "@splitch/worker-runtime";

/**
 * Reports a fault through the scrubbed observability path and returns the
 * reference the agent can quote back.
 *
 * One function for both jobs on purpose. Splitting them is how the previous
 * version drifted: `jsonRpcInternalError` minted a reference and `console.error`d
 * the raw throw, so the reference identified a log line that had bypassed the
 * scrubber and reached no Sentry event at all.
 */
export type McpFaultReporter = (error: unknown) => string;

/**
 * `traceId` is the reference when tracing is on, because it RESOLVES: it opens the
 * trace holding the failing `mcp.server` span and every downstream Control Plane
 * call. The UUID fallback is for the DSN-less paths (local dev, the e2e fleet)
 * where no trace exists to name.
 */
export function mcpFaultReporter(
  observability: Observability,
  traceId: string | undefined,
): McpFaultReporter {
  return (error) => {
    const reference = traceId ?? crypto.randomUUID();
    observability.onError?.({
      requestId: reference,
      code: "INTERNAL_SERVER_ERROR",
      status: 500,
      cause: error,
    });
    return reference;
  };
}

/**
 * The reporter used when a caller injects none. Same code path as production
 * minus the DSN, so a fault in a test or in local dev is scrubbed and logged by
 * the same scrubber rather than by a second, laxer branch.
 */
export function localMcpFaultReporter(): McpFaultReporter {
  return mcpFaultReporter(createWorkerObservability({}, { surface: "mcp-server" }), undefined);
}
