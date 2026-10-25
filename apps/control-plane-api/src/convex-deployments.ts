import { envScope, type Repository } from "@splitch/db";
import { serializeFault } from "@splitch/observability/worker";
import { probeConvexDeployment } from "./convex-deployment-probe";

export async function detectMissingConvexDeployment(
  deps: { repo: Repository; fetcher?: typeof fetch },
  installationId: string,
  callbackUrl: string,
  now: Date,
): Promise<void> {
  if ((await probeConvexDeployment(callbackUrl, deps.fetcher)) !== "deleted") return;
  try {
    await deps.repo.convex.markDeploymentMissing(installationId, now.toISOString());
  } catch (cause) {
    console.error("convex_deployment_dormancy_failed", {
      installationId,
      cause: serializeFault(cause),
    });
  }
}

export async function reprobeDormantConvexDeployments(deps: {
  repo: Repository;
  now: Date;
  fetcher?: typeof fetch;
}): Promise<void> {
  const installations = await deps.repo.convex.dormantDeployments(25);
  for (const installation of installations) {
    const now = deps.now.toISOString();
    await deps.repo.convex.recordDeploymentCheck(installation.installationId, now);
    if ((await probeConvexDeployment(installation.callbackUrl, deps.fetcher)) !== "live") continue;
    await deps.repo.convex.reactivateDeployment(
      envScope(installation.appId, installation.environmentId),
      installation.installationId,
      now,
    );
  }
}
