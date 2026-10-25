import { envScope, type Repository } from "@splitch/db";
import { serializeFault } from "@splitch/observability/worker";
import { mapWithConcurrency } from "./bounded-map";
import { probeConvexDeployment } from "./convex-deployment-probe";

export interface ConvexDeploymentProbeCandidate {
  installationId: string;
  callbackUrl: string;
  probeToken: string;
  failedAt: Date;
}

type ProbeDeps = { repo: Repository; fetcher?: typeof fetch };

export async function probeMissingConvexDeployments(
  deps: ProbeDeps,
  outcomes: PromiseSettledResult<ConvexDeploymentProbeCandidate | undefined>[],
): Promise<void> {
  const candidates = outcomes.flatMap((outcome) =>
    outcome.status === "fulfilled" && outcome.value ? [outcome.value] : [],
  );
  await mapWithConcurrency(candidates, 6, (candidate) =>
    detectMissingConvexDeployment(deps, candidate),
  );
}

export async function detectMissingConvexDeployment(
  deps: ProbeDeps,
  candidate: ConvexDeploymentProbeCandidate,
): Promise<void> {
  if ((await probeConvexDeployment(candidate.callbackUrl, deps.fetcher)) !== "deleted") return;
  try {
    await deps.repo.convex.markDeploymentMissing(
      candidate.installationId,
      candidate.probeToken,
      candidate.failedAt.toISOString(),
    );
  } catch (cause) {
    console.error("convex_deployment_dormancy_failed", {
      installationId: candidate.installationId,
      cause: serializeFault(cause),
    });
  }
}

export async function reprobeDormantConvexDeployments(
  deps: ProbeDeps & {
    now: Date;
  },
): Promise<void> {
  const installations = await deps.repo.convex.dormantDeployments(100);
  await mapWithConcurrency(installations, 6, async (installation) => {
    const now = deps.now.toISOString();
    const scope = envScope(installation.appId, installation.environmentId);
    const observed = await deps.repo.convex.recordDeploymentCheck(
      scope,
      installation.installationId,
      now,
    );
    if (observed?.status !== "active" || !observed.deploymentMissingAt) return;
    if ((await probeConvexDeployment(observed.callbackUrl, deps.fetcher)) !== "live") return;
    await deps.repo.convex.reactivateDeployment(
      scope,
      installation.installationId,
      observed.probeToken,
      now,
    );
  });
}
