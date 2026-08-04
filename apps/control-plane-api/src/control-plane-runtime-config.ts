import type { createRepository } from "@splitch/db";
import type { ControlPlaneAuthOptions } from "./auth-resolver";
import type { ControlPlaneApiEnv } from "./env";
import { makePanelDelegationReplayStore } from "./panel-identity-replay";
import { makePanelSessionAccess } from "./panel-session-access";
import { makePanelSessionStore } from "./session-store";

type PanelProtocol = "none" | "signed" | "bounded-session";

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
  if (protocol === "signed") {
    return {
      allowPanelDelegation: true,
      panelDelegationSecret: requiredPanelDelegationSecret(env),
      panelAccess: makePanelSessionAccess(repo),
      panelDelegationReplay: makePanelDelegationReplayStore(env.PANEL_DELEGATION_REPLAY),
    };
  }
  return {
    allowBoundedPanelSession: true,
    boundedPanelSessions: makePanelSessionStore(env.SESSION_STORE),
  };
}

export function boundedPanelSessionEnabled(env: ControlPlaneApiEnv): boolean {
  const expiresAt = env.CONTROL_PANEL_LEGACY_SESSION_EXPIRES_AT;
  return (
    env.CONTROL_PANEL_LEGACY_SESSION_MODE === "bounded-rollout" &&
    typeof expiresAt === "string" &&
    /^\d{10}$/u.test(expiresAt) &&
    Number(expiresAt) > Math.floor(Date.now() / 1000)
  );
}

function requiredPanelDelegationSecret(env: ControlPlaneApiEnv): string {
  if (env.CONTROL_PANEL_DELEGATION_SECRET) return env.CONTROL_PANEL_DELEGATION_SECRET;
  throw new Error("control-plane-api: CONTROL_PANEL_DELEGATION_SECRET is required");
}
