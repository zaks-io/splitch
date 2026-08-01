import type { McpDelegationReplayDurableObjectNamespace } from "@splitch/worker-runtime";

/**
 * No JWKS origin, no session store: this Worker verifies no caller credential.
 * Its routes are addressed at the Control Plane, which authenticates and forwards
 * a resolved identity over the binding (ADR-0046). The MCP delegation secret is
 * the exception because that hop is Worker-to-Worker, not a user credential.
 */
export interface AnalysisApiEnv {
  MCP_ANALYSIS_DELEGATION_SECRET?: string;
  MCP_DELEGATION_REPLAY?: McpDelegationReplayDurableObjectNamespace;
  SPLITCH_DEPLOYED_COMMIT_SHA?: string;
  SPLITCH_PLATFORM_TARGET?: string;
  TINYBIRD_API_URL?: string;
  TINYBIRD_COPY_TOKEN?: string;
  TINYBIRD_READ_TOKEN?: string;
  SENTRY_DSN?: string;
}
