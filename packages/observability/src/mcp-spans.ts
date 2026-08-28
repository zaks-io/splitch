/**
 * MCP protocol spans, hand-written because `Sentry.wrapMcpServerWithSentry` only
 * wraps `@modelcontextprotocol/sdk`'s `McpServer` class and our server dispatches
 * JSON-RPC directly. Sentry documents this exact fallback: a custom MCP
 * implementation records spans manually with `startSpan`
 * (docs/platforms/javascript/common/mcp-monitoring).
 *
 * Attribute and span-name shapes follow Sentry's MCP convention verbatim so the
 * built-in MCP dashboards and `mcp.tool.name` searches work without custom
 * queries.
 */

import { loadSentry } from "./sentry-module.js";

/** Streamable HTTP is the only transport this server speaks (ADR-0046). */
const MCP_TRANSPORT = "http";
const NETWORK_TRANSPORT = "tcp";

/**
 * The method-specific attribute Sentry expects for each instrumented MCP method,
 * and the suffix its span name carries. Methods absent from this table still get
 * a span named after the method alone -- `tools/list` has no subject to name.
 */
const SUBJECT_ATTRIBUTE_BY_METHOD: Record<string, string> = {
  "tools/call": "mcp.tool.name",
  "resources/read": "mcp.resource.uri",
  "prompts/get": "mcp.prompt.name",
};

export interface McpSpanDescriptor {
  /** JSON-RPC method, e.g. `tools/call`. */
  readonly method: string;
  /** Tool name, resource URI, or prompt name, depending on the method. */
  readonly subject?: string;
  readonly sessionId?: string | null;
}

export interface McpSpanHandle {
  /**
   * Record the outcome shape of a tool call. Deliberately a count and a flag: the
   * result content itself carries flag keys, Targeting Keys, and Evaluation
   * Context, and Sentry gates that behind `recordOutputs` for exactly that reason.
   */
  setToolResult(result: { readonly isError: boolean; readonly contentCount: number }): void;
}

export interface McpSpanRecorder {
  record<T>(descriptor: McpSpanDescriptor, run: (span: McpSpanHandle) => Promise<T>): Promise<T>;
}

export function mcpSpanName(descriptor: McpSpanDescriptor): string {
  return descriptor.subject ? `${descriptor.method} ${descriptor.subject}` : descriptor.method;
}

export function mcpSpanAttributes(
  descriptor: McpSpanDescriptor,
): Record<string, string | undefined> {
  const subjectAttribute = SUBJECT_ATTRIBUTE_BY_METHOD[descriptor.method];
  return {
    "mcp.method.name": descriptor.method,
    "mcp.transport": MCP_TRANSPORT,
    "network.transport": NETWORK_TRANSPORT,
    ...(descriptor.sessionId ? { "mcp.session.id": descriptor.sessionId } : {}),
    ...(subjectAttribute && descriptor.subject ? { [subjectAttribute]: descriptor.subject } : {}),
  };
}

/**
 * A recorder that runs the work and records nothing. Used where `SENTRY_DSN` is
 * absent (local dev, the e2e fleet, unit tests) so span instrumentation never
 * changes control flow or timing on the path that has no Sentry to report to.
 */
export const noopMcpSpanRecorder: McpSpanRecorder = {
  record(_descriptor, run) {
    return run({ setToolResult() {} });
  },
};

export function createMcpSpanRecorder(env: { SENTRY_DSN?: string }): McpSpanRecorder {
  if (!env.SENTRY_DSN) {
    return noopMcpSpanRecorder;
  }
  return {
    async record(descriptor, run) {
      // Already resolved from cache here: `wrapWorkerHandler` awaits the same
      // loader before invoking the handler whenever a DSN is set. Awaiting does
      // not break span parentage -- AsyncLocalStorage carries the active request
      // transaction across the microtask.
      const Sentry = await loadSentry();
      return Sentry.startSpan({ op: "mcp.server", name: mcpSpanName(descriptor) }, async (span) => {
        for (const [key, value] of Object.entries(mcpSpanAttributes(descriptor))) {
          if (value !== undefined) {
            span.setAttribute(key, value);
          }
        }
        return run({
          setToolResult({ isError, contentCount }) {
            span.setAttribute("mcp.tool.result.is_error", isError);
            span.setAttribute("mcp.tool.result.content_count", contentCount);
          },
        });
      });
    },
  };
}
