import type { createRepository } from "@splitch/db";
import { createPerformanceSpanRecorder } from "@splitch/observability/performance-spans";
import type { ControlPlaneAuthOptions } from "./auth-resolver";
import type { ControlPlaneApiEnv } from "./env";
import { makePanelDelegationReplayStore } from "./panel-identity-replay";
import { makePanelSessionAccess } from "./panel-session-access";

type PanelProtocol = "none" | "signed";

export function requiredMcpDelegationSecret(secret: string | undefined): string {
  if (!secret) {
    throw new Error("control-plane-api: MCP_CONTROL_PLANE_DELEGATION_SECRET is required");
  }
  return secret;
}

export function requiredMcpReplayBinding(
  binding: ControlPlaneApiEnv["MCP_DELEGATION_REPLAY"],
): NonNullable<ControlPlaneApiEnv["MCP_DELEGATION_REPLAY"]> {
  if (!binding) throw new Error("control-plane-api: MCP_DELEGATION_REPLAY is required");
  return binding;
}

export function controlPanelAuthOptions(
  env: ControlPlaneApiEnv,
  repo: ReturnType<typeof createRepository>,
  protocol: PanelProtocol,
): ControlPlaneAuthOptions {
  if (protocol === "none") return {};
  return {
    spans: createPerformanceSpanRecorder(env),
    allowPanelDelegation: true,
    panelDelegationSecret: requiredPanelDelegationSecret(env),
    panelAccess: makePanelSessionAccess(repo),
    panelDelegationReplay: makePanelDelegationReplayStore(env.PANEL_DELEGATION_REPLAY),
  };
}

function requiredPanelDelegationSecret(env: ControlPlaneApiEnv): string {
  if (env.CONTROL_PANEL_DELEGATION_SECRET) return env.CONTROL_PANEL_DELEGATION_SECRET;
  throw new Error("control-plane-api: CONTROL_PANEL_DELEGATION_SECRET is required");
}
