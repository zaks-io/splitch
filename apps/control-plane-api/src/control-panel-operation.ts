export type ControlPanelOperation =
  | { id: "apps_create"; orgId: string }
  | { id: "flags_list" | "flags_create"; appId: string; environmentId: string }
  | { id: "flag_config_get"; appId: string; environmentId: string };

const APPS_PATH = /^\/orgs\/([^/]+)\/apps\/?$/;
const FLAGS_PATH = /^\/apps\/([^/]+)\/flags\/?$/;
const FLAG_CONFIG_PATH = /^\/apps\/([^/]+)\/envs\/([^/]+)\/flags\/[^/]+\/config\/?$/;

/** Parse only the operations exposed by the binding-only Control Panel entrypoint. */
export function parseControlPanelOperation(
  method: string,
  pathname: string,
  panelEnvironmentId?: string,
): ControlPanelOperation | null {
  return (
    parseAppsCreate(method, pathname) ??
    parseFlags(method, pathname, panelEnvironmentId) ??
    parseConfig(method, pathname)
  );
}

/** Refuse bearer forwarding before dispatching any binding-only operation. */
export function parseControlPanelBindingOperation(request: Request): ControlPanelOperation | null {
  if (request.headers.has("authorization")) return null;
  return parseControlPanelOperation(
    request.method,
    new URL(request.url).pathname,
    request.headers.get("x-splitch-panel-environment") ?? undefined,
  );
}

function parseAppsCreate(method: string, pathname: string): ControlPanelOperation | null {
  const apps = pathname.match(APPS_PATH);
  if (method !== "POST" || !apps?.[1]) return null;
  const orgId = decodeSegment(apps[1]);
  return orgId ? { id: "apps_create", orgId } : null;
}

function parseFlags(
  method: string,
  pathname: string,
  environmentIdValue?: string,
): ControlPanelOperation | null {
  const flags = pathname.match(FLAGS_PATH);
  if ((method !== "GET" && method !== "POST") || !flags?.[1] || !environmentIdValue) return null;
  const appId = decodeSegment(flags[1]);
  const environmentId = decodeSegment(environmentIdValue);
  if (!appId || !environmentId) return null;
  return { id: method === "GET" ? "flags_list" : "flags_create", appId, environmentId };
}

function parseConfig(method: string, pathname: string): ControlPanelOperation | null {
  const config = pathname.match(FLAG_CONFIG_PATH);
  if (method !== "GET" || !config?.[1] || !config[2]) return null;
  const appId = decodeSegment(config[1]);
  const environmentId = decodeSegment(config[2]);
  return appId && environmentId ? { id: "flag_config_get", appId, environmentId } : null;
}

function decodeSegment(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}
