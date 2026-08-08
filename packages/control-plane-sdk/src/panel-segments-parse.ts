import type { ControlPanelOperation } from "./control-panel-operation.js";

const SEGMENTS_PATH = /^\/apps\/([^/]+)\/segments\/?$/;
const SEGMENT_PATH = /^\/apps\/([^/]+)\/segments\/([^/]+)\/?$/;

const SEGMENT_COLLECTION_METHODS = {
  GET: "segments_list",
  POST: "segments_create",
} as const;

const SEGMENT_RESOURCE_METHODS = {
  GET: "segments_get",
  PATCH: "segments_update",
  DELETE: "segments_delete",
} as const;

export function parseSegments(
  method: string,
  pathname: string,
  environmentValue?: string,
): ControlPanelOperation | null {
  const environmentId = environmentValue ? decodeSegment(environmentValue) : null;
  if (!environmentId) return null;
  return (
    parseSegmentCollection(method, pathname, environmentId) ??
    parseSegmentResource(method, pathname, environmentId)
  );
}

function parseSegmentCollection(
  method: string,
  pathname: string,
  environmentId: string,
): ControlPanelOperation | null {
  const id = SEGMENT_COLLECTION_METHODS[method as keyof typeof SEGMENT_COLLECTION_METHODS];
  const appId = decodeMatch(pathname.match(SEGMENTS_PATH), 1);
  return id && appId ? { id, appId, environmentId } : null;
}

function parseSegmentResource(
  method: string,
  pathname: string,
  environmentId: string,
): ControlPanelOperation | null {
  const id = SEGMENT_RESOURCE_METHODS[method as keyof typeof SEGMENT_RESOURCE_METHODS];
  const resource = pathname.match(SEGMENT_PATH);
  const appId = decodeMatch(resource, 1);
  const segmentId = decodeMatch(resource, 2);
  return id && appId && segmentId ? { id, appId, environmentId, segmentId } : null;
}

function decodeMatch(match: RegExpMatchArray | null, index: number): string | null {
  const value = match?.[index];
  return value ? decodeSegment(value) : null;
}

function decodeSegment(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}
