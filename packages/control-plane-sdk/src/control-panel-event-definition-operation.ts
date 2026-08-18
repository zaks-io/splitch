import type { ControlPanelOperation } from "./control-panel-operation";

const EVENT_DEFINITIONS_PATH = /^\/apps\/([^/]+)\/event-definitions\/?$/;
const EVENT_DEFINITION_PATH = /^\/apps\/([^/]+)\/event-definitions\/([^/]+)\/?$/;
const EVENT_DEFINITION_VERSIONS_PATH = /^\/apps\/([^/]+)\/event-definitions\/([^/]+)\/versions\/?$/;
const EVENT_DEFINITION_VERSION_PATH =
  /^\/apps\/([^/]+)\/event-definitions\/([^/]+)\/versions\/([^/]+)\/?$/;

export function parseEventDefinitionOperation(
  method: string,
  pathname: string,
  environmentValue?: string,
): ControlPanelOperation | null {
  const environmentId = environmentValue ? decodeSegment(environmentValue) : null;
  if (!environmentId) return null;
  return (
    parseVersion(method, pathname, environmentId) ??
    parseVersions(method, pathname, environmentId) ??
    parseDefinition(method, pathname, environmentId) ??
    parseCollection(method, pathname, environmentId)
  );
}

function parseVersion(
  method: string,
  pathname: string,
  environmentId: string,
): ControlPanelOperation | null {
  if (method !== "GET") return null;
  const match = decodedMatch(pathname, EVENT_DEFINITION_VERSION_PATH, 3);
  return match
    ? {
        id: "event_definition_versions_get",
        appId: match[0],
        environmentId,
        eventDefinitionId: match[1],
        versionId: match[2],
      }
    : null;
}

function parseVersions(
  method: string,
  pathname: string,
  environmentId: string,
): ControlPanelOperation | null {
  const id =
    method === "GET"
      ? "event_definition_versions_list"
      : method === "POST"
        ? "event_definition_versions_create"
        : null;
  if (!id) return null;
  const match = decodedMatch(pathname, EVENT_DEFINITION_VERSIONS_PATH, 2);
  return match ? { id, appId: match[0], environmentId, eventDefinitionId: match[1] } : null;
}

function parseDefinition(
  method: string,
  pathname: string,
  environmentId: string,
): ControlPanelOperation | null {
  const id =
    method === "GET"
      ? "event_definitions_get"
      : method === "PATCH"
        ? "event_definitions_update"
        : null;
  if (!id) return null;
  const match = decodedMatch(pathname, EVENT_DEFINITION_PATH, 2);
  return match ? { id, appId: match[0], environmentId, eventDefinitionId: match[1] } : null;
}

function parseCollection(
  method: string,
  pathname: string,
  environmentId: string,
): ControlPanelOperation | null {
  const id =
    method === "GET"
      ? "event_definitions_list"
      : method === "POST"
        ? "event_definitions_create"
        : null;
  if (!id) return null;
  const match = decodedMatch(pathname, EVENT_DEFINITIONS_PATH, 1);
  return match ? { id, appId: match[0], environmentId } : null;
}

function decodedMatch(pathname: string, pattern: RegExp, count: 1): [string] | null;
function decodedMatch(pathname: string, pattern: RegExp, count: 2): [string, string] | null;
function decodedMatch(pathname: string, pattern: RegExp, count: 3): [string, string, string] | null;
function decodedMatch(
  pathname: string,
  pattern: RegExp,
  count: 1 | 2 | 3,
): [string] | [string, string] | [string, string, string] | null {
  const match = pathname.match(pattern);
  if (!match) return null;
  const values = match.slice(1, count + 1).map(decodeSegment);
  if (values.some((value) => !value)) return null;
  return values as [string] | [string, string] | [string, string, string];
}

function decodeSegment(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}
