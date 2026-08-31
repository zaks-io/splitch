import type { AuthDoor } from "@splitch/contracts";
import type { parseControlPanelBindingOperation } from "./control-panel-operation";
import type { PanelSessionAccess } from "./panel-session-access";

type AppScopedPanelOperation = Extract<
  NonNullable<ReturnType<typeof parseControlPanelBindingOperation>>,
  { appId: string }
>;

/** Resolve App authority from live access, with a delete-only durable resume path. */
export async function resolvePanelResourcePrincipal(
  operation: AppScopedPanelOperation,
  actorId: string,
  panelAccess: PanelSessionAccess | undefined,
  authDoor: AuthDoor,
  allowAppDeletionResume: boolean,
) {
  if (!panelAccess) return null;
  const environmentId = "environmentId" in operation ? operation.environmentId : undefined;
  const access = await panelAccess.authorizeApp(actorId, operation.appId, environmentId);
  if (!access && operation.id === "apps_delete" && allowAppDeletionResume) {
    const resumeAccess = await panelAccess.authorizeAppDeletionResume(actorId, operation.appId);
    if (resumeAccess) {
      return {
        ok: true as const,
        principal: {
          kind: "control-plane-token" as const,
          id: actorId,
          scopes: [`app:${resumeAccess.appId}:${resumeAccess.appRole}`],
          orgId: null,
          appId: resumeAccess.appId,
          environmentId: null,
          authDoor,
        },
      };
    }
  }
  if (!access) {
    return {
      ok: false as const,
      reason: "UNAUTHORIZED" as const,
      error: {
        code: "FORBIDDEN" as const,
        message: "live App membership and resource access are required",
        details: {},
      },
    };
  }

  return {
    ok: true as const,
    principal: {
      kind: "control-plane-token" as const,
      id: actorId,
      scopes: [`org:${access.orgId}:${access.orgRole}`, `app:${access.appId}:${access.appRole}`],
      orgId: access.orgId,
      appId: access.appId,
      environmentId: null,
      authDoor,
    },
  };
}
