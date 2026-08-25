import { type ConvexConfigSnapshot, ConvexConfigSnapshotSchema } from "@splitch/contracts";
import { appScope, type EnvScope, type Repository } from "@splitch/db";
import { buildSnapshotFromD1 } from "./config-store-shared";

export async function buildConvexSnapshot(
  repo: Repository,
  scope: EnvScope,
): Promise<ConvexConfigSnapshot> {
  const [flags, environmentVersion] = await Promise.all([
    repo.flags.flags.findMany(appScope(scope.appId)),
    repo.convex.environmentVersion(scope),
  ]);
  const snapshots = (
    await Promise.all(flags.map((flag) => buildSnapshotFromD1(repo, scope, flag.id)))
  ).filter((snapshot) => snapshot !== null);
  const experiments = uniqueById(
    snapshots.flatMap((snapshot) => (snapshot.experiment ? [snapshot.experiment] : [])),
  );
  const runs = uniqueById(snapshots.flatMap((snapshot) => (snapshot.run ? [snapshot.run] : [])));
  return ConvexConfigSnapshotSchema.parse({
    schemaVersion: 1,
    environmentVersion,
    appId: scope.appId,
    environmentId: scope.environmentId,
    flags: snapshots.map((snapshot) => snapshot.flag),
    experiments,
    runs,
  });
}

function uniqueById<T extends { id: string }>(values: T[]): T[] {
  return [...new Map(values.map((value) => [value.id, value])).values()];
}
