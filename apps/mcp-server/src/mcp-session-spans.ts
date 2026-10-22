import type { PerformanceSpanRecorder } from "@splitch/observability/performance-spans";
import type { McpSessionStore } from "./mcp-session-context";

/** Covers the full DO round trip, including lazy creation on its first RPC. */
export function instrumentMcpSessionStore(
  store: McpSessionStore,
  spans: PerformanceSpanRecorder,
): McpSessionStore {
  return {
    create: (...args) =>
      spans.record({ name: "mcp.session.create", op: "mcp.session" }, () => store.create(...args)),
    get: (...args) =>
      spans.record({ name: "mcp.session.get", op: "mcp.session" }, () => store.get(...args)),
    getTransport: (...args) =>
      spans.record({ name: "mcp.session.get_transport", op: "mcp.session" }, () =>
        store.getTransport(...args),
      ),
    set: (...args) =>
      spans.record({ name: "mcp.session.set", op: "mcp.session" }, () => store.set(...args)),
    end: (...args) =>
      spans.record({ name: "mcp.session.end", op: "mcp.session" }, () => store.end(...args)),
  };
}
