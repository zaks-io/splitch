import { env as workerEnv } from "cloudflare:workers";
import type { ControlPlaneOperationResult } from "@splitch/control-plane-sdk";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { controlPanelMutationBindings } from "./bindings";
import { createControlPanelFlagsClient } from "./control-plane-apps";
import { draftIssues, type FlagDraft, flagCreateInput } from "./create-flag-model";
import { type FlagsPageData, readFlagsPage } from "./flags-page-data";
import { loadSessionFromRequest } from "./session";

type FlagsPageScope = { appId: string; environmentId: string };
type CreateFlagInput = { appId: string; environmentId: string; draft: FlagDraft };
type CreateFlagResult = ControlPlaneOperationResult<{ key: string }>;

export const loadControlPanelFlags = createServerFn({ method: "GET" })
  .validator((data: FlagsPageScope) => data)
  .handler(async ({ data }): Promise<ControlPlaneOperationResult<FlagsPageData>> => {
    const authorized = await authorizedFlagsClient(data.environmentId);
    if (!authorized.ok) return authorized.result;
    return readFlagsPage(authorized.flags, data);
  });

export const createControlPanelFlag = createServerFn({ method: "POST" })
  .validator((data: CreateFlagInput) => data)
  .handler(async ({ data }): Promise<CreateFlagResult> => {
    // The client validates to render inline errors; the server revalidates
    // because the draft arrives over the wire and is not trusted.
    const issues = draftIssues(data.draft);
    if (issues.length > 0) {
      return {
        ok: false,
        status: 400,
        error: {
          code: "VALIDATION_ERROR",
          message: "The Flag draft is incomplete",
          details: {
            issues: issues.map((issue) => ({
              path: issue.path.split("."),
              message: issue.message,
            })),
          },
        },
      };
    }

    const authorized = await authorizedFlagsClient(data.environmentId);
    if (!authorized.ok) return authorized.result;
    const result = await authorized.flags.create(flagCreateInput(data.appId, data.draft));
    return result.ok ? { ok: true, status: result.status, data: { key: result.data.key } } : result;
  });

async function authorizedFlagsClient(environmentId: string) {
  const bindings = controlPanelMutationBindings(workerEnv);
  const loaded = await loadSessionFromRequest(bindings.SESSION_STORE, getRequest());
  if (!loaded.ok) {
    return {
      ok: false as const,
      result: {
        ok: false as const,
        status: 401,
        error: { code: "UNAUTHORIZED" as const, message: "authentication required", details: {} },
      },
    };
  }
  return {
    ok: true as const,
    flags: createControlPanelFlagsClient(
      bindings.CONTROL_PLANE_API,
      { actorId: loaded.session.userId, sessionExpiresAt: loaded.session.expiresAt },
      environmentId,
      bindings.CONTROL_PANEL_DELEGATION_SECRET,
    ),
  };
}
