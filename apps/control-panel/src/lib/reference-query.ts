import { queryOptions, type QueryClient } from "@tanstack/react-query";
import type { ApiResult, MutationErrorSurface } from "./api";
import { mutationErrorSurface } from "./api";
import { queryKeys, type AppEnvironmentScope } from "./query-keys";

export type VersionedReference = {
  readonly version: number;
};

export interface ReferenceFlagConfigApi<T extends VersionedReference, Patch> {
  read(scope: AppEnvironmentScope, flagId: string): Promise<ApiResult<T>>;
  update(scope: AppEnvironmentScope, flagId: string, patch: Patch): Promise<ApiResult<T>>;
}

export function referenceFlagConfigQuery<T extends VersionedReference, Patch>(
  api: ReferenceFlagConfigApi<T, Patch>,
  scope: AppEnvironmentScope,
  flagId: string,
) {
  return queryOptions({
    queryKey: queryKeys.flag.detail(scope.appId, scope.environmentId, flagId),
    queryFn: async (): Promise<T> => {
      const result = await api.read(scope, flagId);
      if (!result.ok) {
        throw new ReferenceQueryError(result);
      }
      return result.data;
    },
  });
}

/** A route loader calls this to seed the sole server-state cache before render. */
export function loadReferenceFlagConfig<T extends VersionedReference, Patch>(
  queryClient: QueryClient,
  api: ReferenceFlagConfigApi<T, Patch>,
  scope: AppEnvironmentScope,
  flagId: string,
) {
  return queryClient.ensureQueryData(referenceFlagConfigQuery(api, scope, flagId));
}

export type ReferenceMutationResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly error: MutationErrorSurface };

/**
 * Writes never touch the cache directly. Only a confirmed 200 invalidates the
 * affected query prefix, allowing TanStack Query to refetch persisted state.
 */
export async function updateReferenceFlagConfig<T extends VersionedReference, Patch>(
  queryClient: QueryClient,
  api: ReferenceFlagConfigApi<T, Patch>,
  scope: AppEnvironmentScope,
  flagId: string,
  patch: Patch,
): Promise<ReferenceMutationResult<T>> {
  const result = await api.update(scope, flagId, patch);
  if (!result.ok) {
    return { ok: false, error: mutationErrorSurface(result) };
  }

  await queryClient.invalidateQueries({
    queryKey: queryKeys.flag.prefix(scope.appId, scope.environmentId),
  });
  return { ok: true, data: result.data };
}

class ReferenceQueryError extends Error {
  constructor(readonly result: Extract<ApiResult<never>, { ok: false }>) {
    super(result.error.message);
    this.name = "ReferenceQueryError";
  }
}
