import { env as workerEnv } from "cloudflare:workers";
import type { ControlPlaneOperationResult } from "@splitch/control-plane-sdk";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { controlPanelMutationBindings } from "./bindings";
import { createControlPanelFlagsClient } from "./control-plane-apps";
import { booleanFlagInput } from "./create-flag-model";
import { createFlagConfigApi, type FlagConfigApi, type FlagConfigPatch } from "./flag-config-api";
import { type FlagsPageData, readFlagsPage } from "./flags-page-data";
import { loadSessionFromRequest } from "./session";

type FlagsPageScope = { appId: string; environmentId: string };
type CreateBooleanFlagInput = { appId: string; environmentId: string; key: string };
type CreateBooleanFlagResult = ControlPlaneOperationResult<{ key: string }>;
type FlagConfigScope = FlagsPageScope & { flagId: string };

export const loadControlPanelFlags = createServerFn({ method: "GET" })
  .validator((data: FlagsPageScope) => data)
  .handler(async ({ data }): Promise<ControlPlaneOperationResult<FlagsPageData>> => {
    const authorized = await authorizedFlagsClient(data.environmentId);
    if (!authorized.ok) return authorized.result;
    return readFlagsPage(authorized.flags, data);
  });

export const createControlPanelFlag = createServerFn({ method: "POST" })
  .validator((data: CreateBooleanFlagInput) => data)
  .handler(async ({ data }): Promise<CreateBooleanFlagResult> => {
    const authorized = await authorizedFlagsClient(data.environmentId);
    if (!authorized.ok) return authorized.result;
    const result = await authorized.flags.create(booleanFlagInput(data.appId, data.key));
    return result.ok ? { ok: true, status: result.status, data: { key: result.data.key } } : result;
  });

export const resolveControlPanelFlagId = createServerFn({ method: "GET" })
  .validator((data: FlagsPageScope & { flagKey: string }) => data)
  .handler(async ({ data }) => {
    const authorized = await authorizedFlagsClient(data.environmentId);
    if (!authorized.ok) return authorized.result;
    return createFlagConfigApi(authorized.flags).resolveId(data, data.flagKey);
  });

export const loadControlPanelFlagConfig = createServerFn({ method: "GET" })
  .validator((data: FlagConfigScope) => data)
  .handler(async ({ data }) => {
    const authorized = await authorizedFlagsClient(data.environmentId);
    if (!authorized.ok) return JSON.stringify(authorized.result);
    return JSON.stringify(await createFlagConfigApi(authorized.flags).read(data, data.flagId));
  });

export const updateControlPanelFlagConfig = createServerFn({ method: "POST" })
  .validator((data: FlagConfigScope & { patch: FlagConfigPatch }) => data)
  .handler(async ({ data }) => {
    const authorized = await authorizedFlagsClient(data.environmentId);
    if (!authorized.ok) return JSON.stringify(authorized.result);
    return JSON.stringify(
      await createFlagConfigApi(authorized.flags).update(data, data.flagId, data.patch),
    );
  });

export const controlPanelFlagConfigApi: FlagConfigApi = {
  resolveId: (scope, flagKey) => resolveControlPanelFlagId({ data: { ...scope, flagKey } }),
  read: async (scope, flagId) =>
    parseOperationResult(await loadControlPanelFlagConfig({ data: { ...scope, flagId } })),
  update: async (scope, flagId, patch) =>
    parseOperationResult(await updateControlPanelFlagConfig({ data: { ...scope, flagId, patch } })),
};

function parseOperationResult<T>(value: string): ControlPlaneOperationResult<T> {
  return JSON.parse(value) as ControlPlaneOperationResult<T>;
}

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
