import { type ConfigSnapshot, ConfigSnapshotSchema } from "@splitch/contracts";
import { appScope, type EnvScope, type Repository } from "@splitch/db";
import { buildSnapshotFromD1 } from "./config-store-shared";

export async function buildIntegrationSnapshot(
  repo: Repository,
  scope: EnvScope,
  environmentVersion: number,
): Promise<ConfigSnapshot> {
  const flags = await repo.flags.flags.findMany(appScope(scope.appId));
  const snapshots = (
    await Promise.all(flags.map((flag) => buildSnapshotFromD1(repo, scope, flag.id)))
  ).filter((snapshot) => snapshot !== null);
  return ConfigSnapshotSchema.parse({
    schemaVersion: 1,
    environmentVersion,
    appId: scope.appId,
    environmentId: scope.environmentId,
    flags: snapshots.map((snapshot) => snapshot.flag),
    experiments: uniqueById(
      snapshots.flatMap((snapshot) => (snapshot.experiment ? [snapshot.experiment] : [])),
    ),
    runs: uniqueById(snapshots.flatMap((snapshot) => (snapshot.run ? [snapshot.run] : []))),
  });
}

function uniqueById<T extends { id: string }>(values: T[]): T[] {
  return [...new Map(values.map((value) => [value.id, value])).values()];
}
