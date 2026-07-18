import type { QueryClient } from "@tanstack/react-query";
import type { FlagConfigApi, FlagConfigPatch } from "./flag-config-api";
import type { AppEnvironmentScope } from "./query-keys";
import { loadReferenceFlagConfig, updateReferenceFlagConfig } from "./reference-query";

export function loadFlagConfigRoute(input: {
  queryClient: QueryClient;
  api: FlagConfigApi;
  scope: AppEnvironmentScope;
  flagId: string;
}) {
  return loadReferenceFlagConfig(input.queryClient, input.api, input.scope, input.flagId);
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
