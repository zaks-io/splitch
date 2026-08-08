import { appScope } from "@splitch/db";
import { type HandlerArgs, renderError } from "@splitch/worker-runtime";
import { appNotFound, nowIso } from "./app-environment-model";
import { randomHex } from "./credential-cache";
import { configStoreUnavailable } from "./experiment-errors";
import { objectBody, pathParam } from "./handler-input";
import {
  type MetricSegmentDeps,
  requireWritableApp,
  segmentFromPath,
  segmentNotFound,
  segmentResponse,
} from "./metric-segment-shared";
import { type SegmentDependencies, segmentDependencies } from "./segment-dependencies";

export function makeSegmentHandlers(deps: MetricSegmentDeps) {
  return {
    listSegments: (args: HandlerArgs<unknown>) => listSegments(deps, args),
    createSegment: (args: HandlerArgs<unknown>) => createSegment(deps, args),
    getSegment: (args: HandlerArgs<unknown>) => getSegment(deps, args),
    updateSegment: (args: HandlerArgs<unknown>) => updateSegment(deps, args),
    deleteSegment: (args: HandlerArgs<unknown>) => deleteSegment(deps, args),
  };
}

async function listSegments(
  deps: MetricSegmentDeps,
  { input, requestId }: HandlerArgs<unknown>,
): Promise<Response> {
  const appId = pathParam(input, "appId");
  if (!(await deps.repo.identity.getApp(appId))) return appNotFound(requestId);
  const [rows, rules] = await Promise.all([
    deps.repo.flags.segments.findMany(appScope(appId)),
    deps.repo.flags.listTargetingRulesForApp(appScope(appId)),
  ]);
  const affectedEnvironmentIds: Record<string, string[]> = Object.fromEntries(
    rows.map((row) => [
      row.id,
      [
        ...new Set(
          rules.filter((rule) => rule.segmentId === row.id).map((rule) => rule.environmentId),
        ),
      ],
    ]),
  );
  return Response.json({ items: rows.map(segmentResponse), affectedEnvironmentIds });
}

async function createSegment(
  deps: MetricSegmentDeps,
  { input, principal, requestId }: HandlerArgs<unknown>,
): Promise<Response> {
  const appId = pathParam(input, "appId");
  const body = objectBody(input);
  const writeError = await requireWritableApp(deps, appId, principal, requestId);
  if (writeError) return writeError;

  const now = nowIso(deps);
  const row = await deps.repo.flags.segments.insert(appScope(appId), {
    id: `segment_${randomHex(12)}`,
    appId,
    name: body.name as string,
    ...(body.description ? { description: body.description as string } : {}),
    conditions: JSON.stringify(body.conditions),
    createdAt: now,
    updatedAt: now,
  });
  return Response.json(segmentResponse(row));
}

async function getSegment(
  deps: MetricSegmentDeps,
  { input, requestId }: HandlerArgs<unknown>,
): Promise<Response> {
  const segment = await segmentFromPath(deps, input);
  if (!segment) return segmentNotFound(requestId);
  return Response.json(segmentResponse(segment));
}

async function updateSegment(
  deps: MetricSegmentDeps,
  args: HandlerArgs<unknown>,
): Promise<Response> {
  const appId = pathParam(args.input, "appId");
  const segment = await segmentFromPath(deps, args.input);
  if (!segment) return segmentNotFound(args.requestId);

  const writeError = await requireWritableApp(deps, appId, args.principal, args.requestId);
  if (writeError) return writeError;

  const body = objectBody(args.input);
  const dependencies = await segmentDependencies(deps.repo, appId, segment.id);
  if (dependencies.flagConfigurations.length > 0 && !deps.configStore) {
    return configStoreUnavailable(args.requestId);
  }
  const updated = await deps.repo.flags.updateSegment(appScope(appId), segment.id, {
    ...(body.name !== undefined ? { name: body.name as string } : {}),
    ...(body.description !== undefined ? { description: body.description as string } : {}),
    ...(body.conditions !== undefined ? { conditions: JSON.stringify(body.conditions) } : {}),
    updatedAt: nowIso(deps),
  });
  if (!updated) return segmentNotFound(args.requestId);
  await republishFlagConfigurations(deps, appId, dependencies);
  return Response.json(segmentResponse(updated));
}

async function deleteSegment(
  deps: MetricSegmentDeps,
  args: HandlerArgs<unknown>,
): Promise<Response> {
  const appId = pathParam(args.input, "appId");
  const segment = await segmentFromPath(deps, args.input);
  if (!segment) return segmentNotFound(args.requestId);

  const writeError = await requireWritableApp(deps, appId, args.principal, args.requestId);
  if (writeError) return writeError;

  const dependencies = await segmentDependencies(deps.repo, appId, segment.id);
  if (dependencies.flagConfigurations.length + dependencies.experimentDrafts.length > 0) {
    return segmentNotEmpty(segment.id, dependencies, args.requestId);
  }

  await deps.repo.flags.removeSegment(appScope(appId), segment.id);
  return Response.json({ deleted: true });
}

async function republishFlagConfigurations(
  deps: MetricSegmentDeps,
  appId: string,
  dependencies: SegmentDependencies,
): Promise<void> {
  if (dependencies.flagConfigurations.length === 0) return;
  const configStore = deps.configStore;
  if (!configStore) throw new Error("Segment republish requires Config Store access");
  await Promise.all(
    dependencies.flagConfigurations.map(async (dependency) => {
      const result = await configStore.writerFor(appId, dependency.environmentId).resyncFlagConfig({
        appId,
        environmentId: dependency.environmentId,
        flagId: dependency.flagId,
      });
      if (!result.ok) throw new Error("Segment dependent Flag Configuration no longer exists");
    }),
  );
}

function segmentNotEmpty(
  segmentId: string,
  dependencies: SegmentDependencies,
  requestId: string,
): Response {
  const childCount = dependencies.flagConfigurations.length + dependencies.experimentDrafts.length;
  return renderError(
    {
      code: "RESOURCE_NOT_EMPTY",
      message: "Segment is referenced by mutable Flag Configurations or Experiment drafts",
      details: {
        resourceType: "segment",
        resourceId: segmentId,
        childType: dependencies.flagConfigurations.length > 0 ? "flag-config" : "experiment-draft",
        childCount,
        attemptedOp: "DELETE_SEGMENT",
        segmentDependencies: dependencies,
      },
    },
    { requestId },
  );
}
