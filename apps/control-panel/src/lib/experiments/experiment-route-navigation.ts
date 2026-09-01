import type { PanelExperimentRouteResolutionOutput } from "@splitch/control-plane-sdk/panel-experiments";
import { scopedHref } from "#lib/shell/app-shell-navigation";

type RouteScope = { orgSlug: string; appSlug: string; env: string };

export type ExperimentNotFoundData =
  | { kind: "experiment"; env: string }
  | { kind: "run"; env: string }
  | { kind: "run_elsewhere"; env: string; sourceEnv: string; href: string };

const EXPERIMENT_KEY_ROUTE_PREFIX = "~";

/** Every canonical key reference starts with `~`, so it cannot equal a static child route. */
export function experimentKeyRouteRef(experimentKey: string): string {
  return `${EXPERIMENT_KEY_ROUTE_PREFIX}${encodeURIComponent(experimentKey)}`;
}

/** Canonical references are key-only; old unprefixed bookmarks retain ID-or-key fallback. */
export function experimentRouteReference(routeRef: string): {
  experimentRef: string;
  referenceKind: "key" | "legacy";
} {
  return routeRef.startsWith(EXPERIMENT_KEY_ROUTE_PREFIX)
    ? { experimentRef: routeRef.slice(1), referenceKind: "key" }
    : { experimentRef: routeRef, referenceKind: "legacy" };
}

export function experimentNotFoundData(
  resolution: Exclude<PanelExperimentRouteResolutionOutput, { kind: "experiment" }>,
  scope: RouteScope,
  currentHref: string,
): ExperimentNotFoundData {
  if (resolution.kind === "run_elsewhere") {
    if (resolution.env === scope.env) {
      throw new Error("Run resolution contradicts the loaded Experiment detail");
    }
    return {
      kind: "run_elsewhere",
      env: scope.env,
      sourceEnv: resolution.env,
      href: canonicalExperimentHref(
        { ...scope, env: resolution.env },
        resolution.experimentKey,
        currentHref,
        resolution.runId,
      ),
    };
  }
  return resolution.kind === "run_not_found"
    ? { kind: "run", env: scope.env }
    : { kind: "experiment", env: scope.env };
}

export function canonicalExperimentHref(
  scope: RouteScope,
  experimentKey: string,
  currentHref: string,
  runId?: string,
): string {
  const current = new URL(currentHref, "https://panel.splitch.dev");
  const tab = current.pathname.match(/\/(results|setup)\/?$/)?.[1];
  const experiment = `${scopedHref(scope)}/experiments/${experimentKeyRouteRef(experimentKey)}`;
  const run = runId ? `${experiment}/runs/${encodeURIComponent(runId)}` : experiment;
  return `${run}${tab ? `/${tab}` : ""}${current.search}${current.hash}`;
}
