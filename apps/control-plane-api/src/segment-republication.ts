import { renderError } from "@splitch/worker-runtime";
import type { MetricSegmentDeps } from "./metric-segment-shared";
import type { SegmentDependencies } from "./segment-dependencies";

export interface SegmentRepublishFailure {
  republishedEnvironmentIds: string[];
  notRepublishedEnvironmentIds: string[];
}

export async function republishFlagConfigurations(
  deps: MetricSegmentDeps,
  appId: string,
  dependencies: SegmentDependencies,
): Promise<SegmentRepublishFailure | null> {
  if (dependencies.flagConfigurations.length === 0) return null;
  const configStore = deps.configStore;
  if (!configStore) throw new Error("Segment republish requires Config Store access");
  const byEnvironment = new Map<string, SegmentDependencies["flagConfigurations"]>();
  for (const dependency of dependencies.flagConfigurations) {
    byEnvironment.set(dependency.environmentId, [
      ...(byEnvironment.get(dependency.environmentId) ?? []),
      dependency,
    ]);
  }
  const outcomes = await Promise.allSettled(
    [...byEnvironment].map(async ([environmentId, environmentDependencies]) => {
      await Promise.all(
        environmentDependencies.map(async (dependency) => {
          const result = await configStore.writerFor(appId, environmentId).resyncFlagConfig({
            appId,
            environmentId,
            flagId: dependency.flagId,
          });
          if (!result.ok) {
            throw new Error(
              `Segment dependent Flag Configuration could not be republished: ${result.reason}`,
            );
          }
        }),
      );
      return environmentId;
    }),
  );
  const environmentIds = [...byEnvironment.keys()];
  const republishedEnvironmentIds = outcomes.flatMap((outcome) =>
    outcome.status === "fulfilled" ? [outcome.value] : [],
  );
  const notRepublishedEnvironmentIds = environmentIds.filter(
    (environmentId) => !republishedEnvironmentIds.includes(environmentId),
  );
  return notRepublishedEnvironmentIds.length > 0
    ? { republishedEnvironmentIds, notRepublishedEnvironmentIds }
    : null;
}

export function renderRepublishFailure(requestId: string, failure: SegmentRepublishFailure) {
  return renderError(
    {
      code: "INTERNAL_SERVER_ERROR",
      message: "Segment changed, but dependent Flag Configurations were only partly republished",
      details: { ...failure },
    },
    { requestId },
  );
}
