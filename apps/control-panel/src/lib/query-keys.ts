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

export const queryKeys = {
  app: {
    root,
  },
  experiment: {
    prefix: (appId: string, environmentId: string) =>
      [...entityPrefix(appId, environmentId, "experiment")] as const,
    list: (appId: string, environmentId: string) =>
      [...entityPrefix(appId, environmentId, "experiment"), "list"] as const,
    detail: (appId: string, environmentId: string, experimentId: string) =>
      [...entityPrefix(appId, environmentId, "experiment"), experimentId, "detail"] as const,
    runs: (appId: string, environmentId: string, experimentId: string) =>
      [...entityPrefix(appId, environmentId, "experiment"), experimentId, "run"] as const,
    run: (appId: string, environmentId: string, experimentId: string, runId: string) =>
      [...entityPrefix(appId, environmentId, "experiment"), experimentId, "run", runId] as const,
  },
  flag: {
    prefix: (appId: string, environmentId: string) =>
      [...entityPrefix(appId, environmentId, "flag")] as const,
    list: (appId: string, environmentId: string) =>
      [...entityPrefix(appId, environmentId, "flag"), "list"] as const,
    detail: (appId: string, environmentId: string, flagId: string) =>
      [...entityPrefix(appId, environmentId, "flag"), flagId, "detail"] as const,
    variants: (appId: string, environmentId: string, flagId: string) =>
      [...root(appId, environmentId), "variant", flagId, "list"] as const,
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

export type NudgeEntity = "experiment" | "flag" | "metric" | "segment";

export const nudgeInvalidationPrefix: Record<
  NudgeEntity,
  (appId: string, environmentId: string) => QueryKey
> = {
  experiment: queryKeys.experiment.prefix,
  flag: queryKeys.flag.prefix,
  metric: queryKeys.metric.prefix,
  segment: queryKeys.segment.prefix,
};
