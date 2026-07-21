import {
  CONTROL_PANEL_ENVIRONMENT_HEADER,
  type ControlPanelOperation,
  parseControlPanelOperation as parseSdkControlPanelOperation,
} from "@splitch/control-plane-sdk/control-panel-identity";

export function parseControlPanelOperation(
  method: string,
  pathname: string,
  panelEnvironmentId?: string,
): ControlPanelOperation | null {
  return parseSdkControlPanelOperation(method, pathname, panelEnvironmentId);
}

/** Refuse bearer forwarding before dispatching any binding-only operation. */
export function parseControlPanelBindingOperation(request: Request): ControlPanelOperation | null {
  if (request.headers.has("authorization")) return null;
  return parseControlPanelOperation(
    request.method,
    new URL(request.url).pathname,
    request.headers.get(CONTROL_PANEL_ENVIRONMENT_HEADER) ?? undefined,
  );
}
