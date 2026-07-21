import { appScope } from "@splitch/db";
import type { HandlerArgs } from "@splitch/worker-runtime";
import { appNotFound, nowIso } from "./app-environment-model";
import { randomHex } from "./credential-cache";
import { runningExperimentError } from "./flag-definition-errors";
import { objectBody, pathParam } from "./handler-input";
import {
  type MetricSegmentDeps,
  requireWritableApp,
  runningSegmentReference,
  segmentFromPath,
  segmentNotFound,
  segmentResponse,
} from "./metric-segment-shared";

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
  const rows = await deps.repo.flags.segments.findMany(appScope(appId));
  return Response.json({ items: rows.map(segmentResponse) });
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
  const updated = await deps.repo.flags.updateSegment(appScope(appId), segment.id, {
    ...(body.name !== undefined ? { name: body.name as string } : {}),
    ...(body.description !== undefined ? { description: body.description as string } : {}),
    ...(body.conditions !== undefined ? { conditions: JSON.stringify(body.conditions) } : {}),
    updatedAt: nowIso(deps),
  });
  if (!updated) return segmentNotFound(args.requestId);
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

  const blocker = await runningSegmentReference(deps, appId, segment.id);
  if (blocker) return runningExperimentError(blocker, "DELETE_SEGMENT", args.requestId);

  await deps.repo.flags.removeSegment(appScope(appId), segment.id);
  return Response.json({ deleted: true });
}
