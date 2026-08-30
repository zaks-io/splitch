import type { EnvironmentAttentionRollup } from "@splitch/contracts";
import type { LastVisitedEntry } from "#lib/sessions/last-visited-scope";
import type { ResyncRemedy } from "#lib/live-updates/resync-remedy";
import type { OrgRole } from "#lib/sessions/session";

export interface OrgAppListEnvironment {
  readonly environmentId: string;
  readonly env: string;
  readonly name: string;
  readonly guarded: boolean;
}

/**
 * Either the App's per-Environment health, or the reason it could not be read.
 * There is no third "assume clear" shape: a rollup that failed must render as a
 * stated unknown, because a silently-clear Home row is exactly the disguised failure
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
  readonly flags:
    | { readonly kind: "ready"; readonly count: number; readonly truncated: boolean }
    | { readonly kind: "unavailable"; readonly message: string };
}

/**
 * A resync failure recorded after a create that already succeeded (SPL-203),
 * scoped to this Organization and read fresh on every server render so it
 * survives a reload — unlike `create-app-dialog.tsx`'s local state, which only
 * bridges the moment between submit and the next server read.
 */
export interface PendingAppResync {
  readonly appSlug: string;
  readonly reason: string;
  readonly remedy: ResyncRemedy;
}

export interface OrgAppListView {
  readonly orgId: string;
  readonly orgSlug: string;
  readonly orgRole: OrgRole;
  readonly isProvisional: boolean;
  readonly demoExpiresAt: string | null;
  readonly apps: readonly OrgAppListApp[];
  readonly pendingAppResync: PendingAppResync | null;
  readonly lastVisited: LastVisitedEntry | null;
  readonly now: number;
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

/**
 * `appAttentionSummary`'s severity, ranked worst-first: a known-unhealthy
 * Environment always outranks an unknown one, because "fix this" is more
 * urgent than "we couldn't check this" and an unknown must never bury a
 * confirmed problem. `clear` requires at least one Environment measured clear;
 * an App whose Environments are all `no_data` was read but never measured, so
 * it stays `no_data` rather than claiming a clear result (ADR-0036).
 */
export type AppAttentionSeverity = "unavailable" | "attention" | "unknown" | "clear" | "no_data";

function environmentStates(app: OrgAppListApp) {
  return app.environments.map((environment) => ({
    environment,
    state: environmentAttention(app.attention, environment.environmentId),
  }));
}

/**
 * The single place App-level health is rolled up from per-Environment state.
 * Both `appAttentionSummary` and `appAttentionSeverity` read this so the
 * headline text and its styling can never drift out of sync with each other
 * or with the per-Environment dots (`environmentAttention`).
 */
export function appAttentionSeverity(app: OrgAppListApp): AppAttentionSeverity {
  if (app.attention.kind === "unavailable") return "unavailable";
  const states = environmentStates(app).map(({ state }) => state.kind);
  if (states.includes("attention")) return "attention";
  if (states.includes("unknown")) return "unknown";
  return states.includes("clear") ? "clear" : "no_data";
}

/** The one-line summary shown in the Home table's Attention badge. */
export function appAttentionSummary(app: OrgAppListApp): string {
  const severity = appAttentionSeverity(app);
  if (severity === "unavailable") return "Experiment health unavailable";
  if (severity === "clear") return "No Experiment needs attention";
  if (severity === "no_data") return "No Experiment data yet";

  const states = environmentStates(app);
  // `attention` ranks above `unknown` (see AppAttentionSeverity): a
  // known-unhealthy Environment is reported even when another Environment in
  // the same App is unknown, so unknown can never mask a confirmed problem.
  const wantedKind = severity;
  const named = states
    .filter(({ state }) => state.kind === wantedKind)
    .map(({ environment }) => environment.env);

  if (severity === "attention") return `Needs attention in ${named.join(", ")}`;
  return `Health unknown in ${named.join(", ")}`;
}
