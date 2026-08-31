import { delegationActor, type McpAccessTokenActor } from "./mcp-access-token";
import type { OperationSdkResolver } from "./mcp-operation-sdks";
import type { McpSessionContextValidator } from "./mcp-session-context";

/**
 * The production `McpSessionContextValidator`. Every suite outside the three
 * context-resolution tests injects `async () => ({ ok: true })` instead, so this
 * is the only place the real two-call resolution is exercised. Change it and the
 * rest of the suite will not notice.
 *
 * The resolver is called inside the validator, not when it is built, so
 * `context_use` refuses its own malformed arguments before the Control Plane
 * origin and delegation secret are demanded.
 */
export function controlPlaneContextValidator(
  controlPlane: OperationSdkResolver,
  actor: McpAccessTokenActor,
): McpSessionContextValidator {
  const callOptions = {
    delegation: delegationActor(actor),
  };
  return async (context) => {
    const sdk = controlPlane();
    // `environments_get` already 404s on a wrong App, so this extra round trip
    // buys nothing but the message: without it a bad App id and a bad
    // Environment id are indistinguishable, and the agent retries the wrong
    // one. It is not redundant, so do not fold it into the call below.
    const app = await sdk.callOperationById("apps_get", { appId: context.appId }, callOptions);
    if (!app.ok) {
      return { ok: false, message: `App "${context.appId}" did not resolve.` };
    }

    const environment = await sdk.callOperationById("environments_get", context, callOptions);
    return environment.ok
      ? { ok: true }
      : {
          ok: false,
          message: `Environment "${context.environmentId}" did not resolve in App "${context.appId}".`,
        };
  };
}
