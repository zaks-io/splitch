/**
 * Canonical emission boundaries for Sentry + Axiom wiring.
 * Cross-surface tests iterate this list — add a surface here when a new
 * deployable or harness can emit observability data.
 */

export const OBSERVABILITY_SURFACE_KINDS = ["worker", "cli", "sdk-harness"] as const;
export type ObservabilitySurfaceKind = (typeof OBSERVABILITY_SURFACE_KINDS)[number];

export const OBSERVABILITY_SURFACES = [
  { id: "control-plane-api", kind: "worker" },
  { id: "evaluation-api", kind: "worker" },
  { id: "event-ingest-api", kind: "worker" },
  { id: "analysis-api", kind: "worker" },
  { id: "auth-api", kind: "worker" },
  { id: "control-panel", kind: "worker" },
  { id: "marketing", kind: "worker" },
  { id: "mcp-server", kind: "worker" },
  { id: "cli", kind: "cli" },
  { id: "sdk-harness", kind: "sdk-harness" },
] as const satisfies ReadonlyArray<{ id: string; kind: ObservabilitySurfaceKind }>;

export type ObservabilitySurfaceId = (typeof OBSERVABILITY_SURFACES)[number]["id"];

const surfaceIds = new Set(OBSERVABILITY_SURFACES.map((surface) => surface.id));

export function isObservabilitySurfaceId(value: string): value is ObservabilitySurfaceId {
  return surfaceIds.has(value as ObservabilitySurfaceId);
}

export function observabilitySurfaceIds(): ObservabilitySurfaceId[] {
  return OBSERVABILITY_SURFACES.map((surface) => surface.id);
}
