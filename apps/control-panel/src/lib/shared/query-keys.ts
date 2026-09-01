import type { DeltaNudgeEntity } from "@splitch/contracts";

export type AppEnvironmentScope = {
  readonly appId: string;
  readonly environmentId: string;
};

type QueryKey = readonly string[];

function root(appId: string, environmentId: string) {
  return ["app", appId, "env", environmentId] as const;
}

function entityPrefix(appId: string, environmentId: string, entity: string): QueryKey {
  return [...root(appId, environmentId), entity];
}

function variantPrefix(appId: string, environmentId: string) {
  return [...entityPrefix(appId, environmentId, "variant")] as const;
}

function variantList(appId: string, environmentId: string, flagId: string) {
  return [...variantPrefix(appId, environmentId), flagId, "list"] as const;
}

export const queryKeys = {
  session: {
    scope: (orgSlug: string, appSlug: string, env: string) =>
      ["session", "scope", orgSlug, appSlug, env] as const,
    scopedVisit: (orgSlug: string, appSlug: string, env: string, visitPath: string | null) =>
      ["session", "scope", orgSlug, appSlug, env, visitPath ?? "no-visit"] as const,
  },
  org: {
    // Sentry keeps one signing secret per provider for a whole Sentry
    // organization, so the installation is Org-scoped and its key must not sit
    // under an App or an Environment.
    sentryInstallations: (orgId: string) => ["org", orgId, "sentry-installations"] as const,
  },
  app: {
    root,
    settingsPage: (appId: string, environmentId: string) =>
      [...root(appId, environmentId), "settings-page"] as const,
    // App Settings is App-scoped, so its key is NOT under an Environment: the
    // same data must not be cached once per Environment the operator visits.
    settings: (appId: string) => ["app", appId, "settings"] as const,
  },
  environment: {
    settings: (appId: string, environmentId: string) =>
      [...entityPrefix(appId, environmentId, "environment"), "settings"] as const,
    exposureStatus: (appId: string, environmentId: string) =>
      [...entityPrefix(appId, environmentId, "environment"), "exposure-status"] as const,
    convexInstallations: (appId: string, environmentId: string) =>
      [...entityPrefix(appId, environmentId, "environment"), "convex-installations"] as const,
    cloudflareInstallations: (appId: string, environmentId: string) =>
      [...entityPrefix(appId, environmentId, "environment"), "cloudflare-installations"] as const,
  },
  experiment: {
    prefix: (appId: string, environmentId: string) =>
      [...entityPrefix(appId, environmentId, "experiment")] as const,
    list: (appId: string, environmentId: string) =>
      [...entityPrefix(appId, environmentId, "experiment"), "list"] as const,
    detailPrefix: (appId: string, environmentId: string, experimentId: string) =>
      [...entityPrefix(appId, environmentId, "experiment"), experimentId] as const,
    detail: (appId: string, environmentId: string, experimentId: string) =>
      [...entityPrefix(appId, environmentId, "experiment"), experimentId, "detail"] as const,
    runs: (appId: string, environmentId: string, experimentId: string) =>
      [...entityPrefix(appId, environmentId, "experiment"), experimentId, "run"] as const,
    run: (appId: string, environmentId: string, experimentId: string, runId: string) =>
      [...entityPrefix(appId, environmentId, "experiment"), experimentId, "run", runId] as const,
    results: (appId: string, environmentId: string, experimentId: string, runId: string) =>
      [
        ...entityPrefix(appId, environmentId, "experiment"),
        experimentId,
        "run",
        runId,
        "results",
      ] as const,
  },
  flag: {
    prefix: (appId: string, environmentId: string) =>
      [...entityPrefix(appId, environmentId, "flag")] as const,
    list: (appId: string, environmentId: string) =>
      [...entityPrefix(appId, environmentId, "flag"), "list"] as const,
    detailPrefix: (appId: string, environmentId: string, flagId: string) =>
      [...entityPrefix(appId, environmentId, "flag"), flagId] as const,
    detail: (appId: string, environmentId: string, flagId: string) =>
      [...entityPrefix(appId, environmentId, "flag"), flagId, "detail"] as const,
    variants: variantList,
  },
  variant: {
    prefix: variantPrefix,
    list: variantList,
  },
  metric: {
    prefix: (appId: string, environmentId: string) =>
      [...entityPrefix(appId, environmentId, "metric")] as const,
    list: (appId: string, environmentId: string) =>
      [...entityPrefix(appId, environmentId, "metric"), "list"] as const,
    detail: (appId: string, environmentId: string, metricId: string) =>
      [...entityPrefix(appId, environmentId, "metric"), metricId, "detail"] as const,
  },
  segment: {
    prefix: (appId: string, environmentId: string) =>
      [...entityPrefix(appId, environmentId, "segment")] as const,
    list: (appId: string, environmentId: string) =>
      [...entityPrefix(appId, environmentId, "segment"), "list"] as const,
    detail: (appId: string, environmentId: string, segmentId: string) =>
      [...entityPrefix(appId, environmentId, "segment"), segmentId, "detail"] as const,
  },
} as const;

export const nudgeInvalidationPrefix: Record<
  DeltaNudgeEntity,
  (appId: string, environmentId: string) => QueryKey
> = {
  experiment: queryKeys.experiment.prefix,
  flag: queryKeys.flag.prefix,
  run: queryKeys.experiment.prefix,
  segment: queryKeys.segment.prefix,
};
