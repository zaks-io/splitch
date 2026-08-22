import { scopedHref } from "./app-shell-navigation";
import {
  attentionLabel,
  environmentAttention,
  type OrgAppListApp,
  type OrgAppListEnvironment,
  type OrgAppListView,
} from "./org-app-list";

export interface NeedsYouItem {
  readonly appSlug: string;
  readonly env: string;
  readonly environmentName: string;
  readonly severity: "attention" | "unknown";
  readonly reason: string;
  readonly href: string;
}

/** The empty state says what was checked, so "clear" is never claimed over nothing. */
export function needsYouEmptyCopy(view: OrgAppListView): string {
  if (view.apps.length === 0) return "Nothing needs you yet. This Organization has no Apps.";
  if (view.apps.every((app) => app.environments.length === 0)) {
    return "Nothing needs you yet. No App has an Environment to watch.";
  }
  return "Nothing needs you. Experiment health is clear in every Environment.";
}

export function needsYouItems(view: OrgAppListView): NeedsYouItem[] {
  const attention: NeedsYouItem[] = [];
  const unknown: NeedsYouItem[] = [];

  for (const app of view.apps) {
    for (const environment of app.environments) {
      const item = needsYouItem(view.orgSlug, app, environment);
      if (item) (item.severity === "attention" ? attention : unknown).push(item);
    }
  }

  return [...attention, ...unknown];
}

function needsYouItem(
  orgSlug: string,
  app: OrgAppListApp,
  environment: OrgAppListEnvironment,
): NeedsYouItem | null {
  const state = environmentAttention(app.attention, environment.environmentId);
  if (state.kind !== "attention" && state.kind !== "unknown") return null;

  const reason = attentionLabel(state, environment.name);
  if (!reason) throw new Error("Needs-you attention item is missing its reason");
  return {
    appSlug: app.appSlug,
    env: environment.env,
    environmentName: environment.name,
    severity: state.kind,
    reason,
    href: scopedHref({ orgSlug, appSlug: app.appSlug, env: environment.env }),
  };
}
