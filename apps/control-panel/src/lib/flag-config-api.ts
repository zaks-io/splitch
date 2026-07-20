import type {
  ControlPlaneOperationOptions,
  ControlPlaneOperationResult,
  FlagConfigGetOutput,
  FlagConfigUpdateInput,
  FlagsClient,
} from "@splitch/control-plane-sdk";
import type { AppEnvironmentScope } from "./query-keys";

export type FlagConfigPatch = Omit<FlagConfigUpdateInput, "appId" | "environmentId" | "flagId">;

export interface FlagConfigApi {
  resolveId(
    scope: AppEnvironmentScope,
    flagKey: string,
  ): Promise<ControlPlaneOperationResult<{ flagId: string }>>;
  read(
    scope: AppEnvironmentScope,
    flagId: string,
  ): Promise<ControlPlaneOperationResult<FlagConfigGetOutput>>;
  update(
    scope: AppEnvironmentScope,
    flagId: string,
    patch: FlagConfigPatch,
  ): Promise<ControlPlaneOperationResult<FlagConfigGetOutput>>;
}

/** Thin Control Panel adapter over the contract-derived typed SDK route group. */
export function createFlagConfigApi(
  flags: Pick<FlagsClient, "getConfig" | "list" | "updateConfig">,
  options?: ControlPlaneOperationOptions,
): FlagConfigApi {
  return {
    resolveId: async (scope, flagKey) => {
      const result = await flags.list({ appId: scope.appId }, options);
      if (!result.ok) return result;
      const flag = result.data.items.find((candidate) => candidate.key === flagKey);
      return flag
        ? { ok: true, status: 200, data: { flagId: flag.id } }
        : {
            ok: false,
            status: 404,
            error: {
              code: "FLAG_NOT_FOUND",
              message: "Flag not found",
              details: {},
            },
          };
    },
    read: (scope, flagId) => flags.getConfig({ ...scope, flagId }, options),
    update: (scope, flagId, patch) => flags.updateConfig({ ...scope, flagId, ...patch }, options),
  };
}
