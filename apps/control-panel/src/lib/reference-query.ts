import type { ApprovalRequest } from "@splitch/contracts";
import type { FlagConfigGetOutput } from "@splitch/control-plane-sdk";
import { type QueryClient, queryOptions } from "@tanstack/react-query";
import type { ApiResult, MutationErrorSurface } from "./api";
import { mutationErrorSurface } from "./api";
import type { FlagConfigApi, FlagConfigPatch } from "./flag-config-api";
import { type AppEnvironmentScope, queryKeys } from "./query-keys";

export function referenceFlagConfigQuery(
  api: FlagConfigApi,
  scope: AppEnvironmentScope,
  flagId: string,
) {
  return queryOptions({
    queryKey: queryKeys.flag.detail(scope.appId, scope.environmentId, flagId),
    queryFn: async (): Promise<FlagConfigGetOutput> => {
      const result = await api.read(scope, flagId);
      if (!result.ok) {
        throw new ReferenceQueryError(result);
      }
      return result.data;
    },
  });
}

/** A route loader calls this to seed the sole server-state cache before render. */
export function loadReferenceFlagConfig(
  queryClient: QueryClient,
  api: FlagConfigApi,
  scope: AppEnvironmentScope,
  flagId: string,
) {
  return queryClient.ensureQueryData(referenceFlagConfigQuery(api, scope, flagId));
}

export type ReferenceMutationResult =
  | {
      readonly ok: true;
      readonly data: FlagConfigGetOutput;
      readonly approvalRequest: ApprovalRequest | null;
    }
  | { readonly ok: false; readonly error: MutationErrorSurface };

/**
 * Writes never touch the cache directly. Only a confirmed 200 invalidates the
 * affected query prefix, allowing TanStack Query to refetch persisted state.
 */
export async function updateReferenceFlagConfig(
  queryClient: QueryClient,
  api: FlagConfigApi,
  scope: AppEnvironmentScope,
  flagId: string,
  patch: FlagConfigPatch,
): Promise<ReferenceMutationResult> {
  const result = await api.update(scope, flagId, patch);
  if (!result.ok) {
    return { ok: false, error: mutationErrorSurface(result) };
  }

  await queryClient.invalidateQueries({
    queryKey: queryKeys.flag.prefix(scope.appId, scope.environmentId),
  });
  return {
    ok: true,
    data: result.data.config,
    approvalRequest: result.data.approvalRequest,
  };
}

class ReferenceQueryError extends Error {
  constructor(readonly result: Extract<ApiResult<never>, { ok: false }>) {
    super(result.error.message);
    this.name = "ReferenceQueryError";
  }
}
