import type { ConvexConfigSnapshot } from "@splitch/contracts";
import type { EnvScope, Repository } from "@splitch/db";
import { buildIntegrationSnapshot } from "./integration-snapshot";

export async function buildConvexSnapshot(
  repo: Repository,
  scope: EnvScope,
): Promise<ConvexConfigSnapshot> {
  const version = await repo.convex.environmentVersion(scope);
  return buildIntegrationSnapshot(repo, scope, version);
}
