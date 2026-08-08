import type { McpAccessTokenActor } from "./mcp-access-token";
import type { OperationSdk } from "./mcp-operation-sdks";
import type { McpSessionContextValidator } from "./mcp-session-context";

export function controlPlaneContextValidator(
  controlPlane: OperationSdk,
  actor: McpAccessTokenActor,
): McpSessionContextValidator {
  const callOptions = {
    delegation: { subject: actor.subject, scopes: actor.scopes, authDoor: actor.authDoor },
  };
  return async (context) => {
    const app = await controlPlane.callOperationById(
      "apps_get",
      { appId: context.appId },
      callOptions,
    );
    if (!app.ok) {
      return { ok: false, message: `App "${context.appId}" did not resolve.` };
    }

    const environment = await controlPlane.callOperationById(
      "environments_get",
      context,
      callOptions,
    );
    return environment.ok
      ? { ok: true }
      : {
          ok: false,
          message: `Environment "${context.environmentId}" did not resolve in App "${context.appId}".`,
        };
  };
}
