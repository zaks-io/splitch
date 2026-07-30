import type {
  ControlPlaneOperationOptions,
  ControlPlaneOperationResult,
  FlagConfigGetOutput,
  FlagConfigUpdateInput,
  FlagConfigUpdateOutput,
  FlagsClient,
} from "@splitch/control-plane-sdk";
import type { AppEnvironmentScope } from "./query-keys";

export type FlagConfigPatch = Omit<FlagConfigUpdateInput, "appId" | "environmentId" | "flagId">;

export interface FlagConfigApi {
  read(
    scope: AppEnvironmentScope,
    flagId: string,
  ): Promise<ControlPlaneOperationResult<FlagConfigGetOutput>>;
  update(
    scope: AppEnvironmentScope,
    flagId: string,
    patch: FlagConfigPatch,
  ): Promise<ControlPlaneOperationResult<FlagConfigUpdateOutput>>;
}

/** Thin Control Panel adapter over the contract-derived typed SDK route group. */
export function createFlagConfigApi(
  flags: Pick<FlagsClient, "getConfig" | "updateConfig">,
  options?: ControlPlaneOperationOptions,
): FlagConfigApi {
  return {
    read: (scope, flagId) => flags.getConfig({ ...scope, flagId }, options),
    update: (scope, flagId, patch) =>
      flags.updateConfig(
        {
          ...scope,
          flagId,
          ...patch,
          review: patch.review ?? { action: "approve_and_apply" },
        },
        options,
      ),
  };
}
