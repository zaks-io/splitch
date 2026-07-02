import { renderError } from "@splitch/worker-runtime";
import { appAdminScope } from "./scope-binding.js";

const APP_WRITE_ROLES = ["owner", "admin"] as const;
const APP_DELETE_ROLES = ["owner"] as const;

export function requireAppAdmin(
  appId: string,
  heldScopes: readonly string[],
  requestId: string,
): Response | null {
  return requireAppRole(appId, heldScopes, ["admin"], requestId);
}

export function requireAppWrite(
  appId: string,
  heldScopes: readonly string[],
  requestId: string,
): Response | null {
  return requireAppRole(appId, heldScopes, APP_WRITE_ROLES, requestId);
}

export function requireAppDelete(
  appId: string,
  heldScopes: readonly string[],
  requestId: string,
): Response | null {
  return requireAppRole(appId, heldScopes, APP_DELETE_ROLES, requestId);
}

function requireAppRole(
  appId: string,
  heldScopes: readonly string[],
  allowedRoles: readonly ("owner" | "admin" | "member")[],
  requestId: string,
): Response | null {
  const requiredScopes = allowedRoles.map((role) =>
    role === "admin" ? appAdminScope(appId) : `app:${appId}:${role}`,
  );
  if (requiredScopes.some((scope) => heldScopes.includes(scope))) return null;
  return renderError(
    {
      code: "INSUFFICIENT_SCOPES",
      message: "credential lacks required scopes",
      details: { requiredScopes, heldScopes: [...heldScopes] },
    },
    { requestId },
  );
}
