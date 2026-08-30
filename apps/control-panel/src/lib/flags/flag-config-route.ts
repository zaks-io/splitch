import type { QueryClient } from "@tanstack/react-query";
import type { FlagConfigApi, FlagConfigPatch } from "#lib/flags/flag-config-api";
import type { AppEnvironmentScope } from "#lib/shared/query-keys";
import { loadReferenceFlagConfig, updateReferenceFlagConfig } from "#lib/shared/reference-query";

export function loadFlagConfigRoute(input: {
  queryClient: QueryClient;
  api: FlagConfigApi;
  scope: AppEnvironmentScope;
  flagId: string;
}): Promise<void> {
  return loadReferenceFlagConfig(input.queryClient, input.api, input.scope, input.flagId).then(
    () => undefined,
  );
}

export function updateFlagConfigRoute(input: {
  queryClient: QueryClient;
  api: FlagConfigApi;
  scope: AppEnvironmentScope;
  flagId: string;
  patch: FlagConfigPatch;
}) {
  return updateReferenceFlagConfig(
    input.queryClient,
    input.api,
    input.scope,
    input.flagId,
    input.patch,
  );
}
