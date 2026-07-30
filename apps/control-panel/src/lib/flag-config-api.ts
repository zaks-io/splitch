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
    // `review` is forwarded exactly as the caller supplied it and is never
    // defaulted. Injecting `approve_and_apply` here made the panel silently
    // self-approve every Policy-gated change — a no-op gate on the one surface
    // that has no confirmation UI. Absent an explicit Review the Worker answers
    // APPROVAL_REVIEW_REQUIRED with the pending request id, which is what the
    // panel must surface until the Review UI lands (SPL-118/122/151).
    update: (scope, flagId, patch) => flags.updateConfig({ ...scope, flagId, ...patch }, options),
  };
}
