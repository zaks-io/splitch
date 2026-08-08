import {
  CONTROL_PANEL_ENVIRONMENT_HEADER,
  type ControlPanelOperation,
  parseControlPanelOperation as parseSdkControlPanelOperation,
} from "@splitch/control-plane-sdk/control-panel-identity";

export function parseControlPanelOperation(
  method: string,
  pathname: string,
  panelEnvironmentId?: string,
  search?: URLSearchParams | string,
): ControlPanelOperation | null {
  return parseSdkControlPanelOperation(method, pathname, panelEnvironmentId, search);
}

/** Refuse bearer forwarding before dispatching any binding-only operation. */
export function parseControlPanelBindingOperation(request: Request): ControlPanelOperation | null {
  if (request.headers.has("authorization")) return null;
  const url = new URL(request.url);
  return parseControlPanelOperation(
    request.method,
    url.pathname,
    request.headers.get(CONTROL_PANEL_ENVIRONMENT_HEADER) ?? undefined,
    url.searchParams,
  );
}
