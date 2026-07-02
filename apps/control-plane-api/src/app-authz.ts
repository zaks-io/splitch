import { renderError } from "@splitch/worker-runtime";
import { appAdminScope } from "./scope-binding.js";

export function requireAppAdmin(
  appId: string,
  heldScopes: readonly string[],
  requestId: string,
): Response | null {
  const requiredScope = appAdminScope(appId);
  if (heldScopes.includes(requiredScope)) return null;
  return renderError(
    {
      code: "INSUFFICIENT_SCOPES",
      message: "credential lacks required scopes",
      details: { requiredScopes: [requiredScope], heldScopes: [...heldScopes] },
    },
    { requestId },
  );
}
