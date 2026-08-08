import type { ControlPanelOperation } from "./control-panel-operation";

const FLAGS_PATH = /^\/apps\/([^/]+)\/flags\/?$/;
const FLAG_PATH = /^\/apps\/([^/]+)\/flags\/([^/]+)\/?$/;
const FLAG_COLLECTION_METHODS = {
  GET: "flags_list",
  POST: "flags_create",
} as const;
const FLAG_RESOURCE_METHODS = {
  GET: "flag_get",
} as const;

/**
 * App-scoped Flag collection and resource reads the Panel may claim. The
 * resource read requires an explicit `by` query (`id` | `key`); missing and
 * unknown values are refused so the signed claim always names the selector mode.
 */
export function parseFlags(
  method: string,
  pathname: string,
  environmentValue?: string,
  searchParams?: URLSearchParams,
): ControlPanelOperation | null {
  if (!environmentValue) return null;
  const environmentId = decodeSegment(environmentValue);
  if (!environmentId) return null;
  return (
    parseFlagCollection(method, pathname, environmentId) ??
    parseFlagResource(method, pathname, environmentId, searchParams)
  );
}

function parseFlagCollection(
  method: string,
  pathname: string,
  environmentId: string,
): ControlPanelOperation | null {
  const id = FLAG_COLLECTION_METHODS[method as keyof typeof FLAG_COLLECTION_METHODS];
  const appId = decodeMatch(pathname.match(FLAGS_PATH), 1);
  return id && appId ? { id, appId, environmentId } : null;
}

function parseFlagResource(
  method: string,
  pathname: string,
  environmentId: string,
  searchParams?: URLSearchParams,
): ControlPanelOperation | null {
  const id = FLAG_RESOURCE_METHODS[method as keyof typeof FLAG_RESOURCE_METHODS];
  const resource = pathname.match(FLAG_PATH);
  const appId = decodeMatch(resource, 1);
  const flagId = decodeMatch(resource, 2);
  const by = parseFlagSelectorMode(searchParams);
  return id && appId && flagId && by ? { id, appId, environmentId, flagId, by } : null;
}

function parseFlagSelectorMode(searchParams?: URLSearchParams): "id" | "key" | null {
  const by = searchParams?.get("by");
  return by === "id" || by === "key" ? by : null;
}

function decodeMatch(match: RegExpMatchArray | null, index: number): string | null {
  return match?.[index] ? decodeSegment(match[index]) : null;
}

function decodeSegment(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}
