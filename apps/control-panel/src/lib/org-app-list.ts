import type { EnvironmentAttentionRollup } from "@splitch/contracts";
import type { OrgRole } from "./session";

export interface OrgAppListEnvironment {
  readonly environmentId: string;
  readonly env: string;
  readonly name: string;
}

/**
 * Either the App's per-Environment health, or the reason it could not be read.
 * There is no third "assume clear" shape: a rollup that failed must render as a
 * stated unknown, because a silently-clear card is exactly the disguised failure
 * ADR-0036 forbids.
 */
export type AppAttention =
  | { readonly kind: "ready"; readonly items: readonly EnvironmentAttentionRollup[] }
  | { readonly kind: "unavailable"; readonly message: string };

export interface OrgAppListApp {
  readonly appId: string;
  readonly appSlug: string;
  readonly environments: readonly OrgAppListEnvironment[];
  readonly attention: AppAttention;
}

export interface OrgAppListView {
  readonly orgId: string;
  readonly orgSlug: string;
  readonly orgRole: OrgRole;
  readonly isProvisional: boolean;
  readonly demoExpiresAt: string | null;
  readonly apps: readonly OrgAppListApp[];
}

export type EnvironmentAttentionState =
  | { readonly kind: "clear" }
  | { readonly kind: "no_data" }
  | { readonly kind: "attention"; readonly srm: boolean; readonly guardrail: boolean }
  | { readonly kind: "unknown"; readonly message: string };

/**
 * Org role matrix: "Create App" is owner/admin. The panel renders the locked
 * affordance; the Control Plane Worker is the guardian (ADR-0023), so this gate
 * is presentation only and never the thing that keeps a member out.
 */
export function canCreateApp(role: OrgRole): boolean {
  return role === "owner" || role === "admin";
}

/**
 * An Environment missing from an otherwise-successful rollup is a contract
 * breach, not a clear result, so it resolves to `unknown` rather than inheriting
 * the calm state by omission.
 */
export function environmentAttention(
  attention: AppAttention,
  environmentId: string,
): EnvironmentAttentionState {
  if (attention.kind === "unavailable") {
    return { kind: "unknown", message: attention.message };
  }
  const item = attention.items.find((candidate) => candidate.environmentId === environmentId);
  if (!item) {
    return {
      kind: "unknown",
      message: "The Control Plane returned no health for this Environment",
    };
  }
  if (item.state === "attention") {
    return { kind: "attention", srm: item.srm, guardrail: item.guardrail };
  }
  return { kind: item.state };
}

/** The screen-reader sentence for an Environment link's health marker. */
export function attentionLabel(
  state: EnvironmentAttentionState,
  environmentName: string,
): string | null {
  switch (state.kind) {
    case "attention":
      return `${environmentName} needs attention: ${attentionReasons(state).join(" and ")}.`;
    case "unknown":
      return `${environmentName} health is unknown: ${state.message}.`;
    default:
      return null;
  }
}

function attentionReasons(state: Extract<EnvironmentAttentionState, { kind: "attention" }>) {
  const reasons: string[] = [];
  if (state.srm) reasons.push("Sample Ratio Mismatch firing");
  if (state.guardrail) reasons.push("Guardrail breached");
  return reasons;
}

/** The one-line summary shown under the App name, above the Environment links. */
export function appAttentionSummary(app: OrgAppListApp): string {
  if (app.attention.kind === "unavailable") return "Experiment health unavailable";
  const failing = app.environments.filter(
    (environment) =>
      environmentAttention(app.attention, environment.environmentId).kind === "attention",
  );
  if (failing.length === 0) return "No Experiment needs attention";
  return `Needs attention in ${failing.map((environment) => environment.env).join(", ")}`;
}
