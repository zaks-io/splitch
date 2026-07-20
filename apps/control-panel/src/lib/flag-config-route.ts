import type { QueryClient } from "@tanstack/react-query";
import type { FlagConfigApi, FlagConfigPatch } from "./flag-config-api";
import type { AppEnvironmentScope } from "./query-keys";
import { loadReferenceFlagConfig, updateReferenceFlagConfig } from "./reference-query";

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

export async function loadFlagConfigByKeyRoute(input: {
  queryClient: QueryClient;
  api: FlagConfigApi;
  scope: AppEnvironmentScope;
  flagKey: string;
}): Promise<string> {
  const resolved = await input.api.resolveId(input.scope, input.flagKey);
  if (!resolved.ok) {
    if (resolved.error.code === "FLAG_NOT_FOUND") throw new FlagConfigNotFoundError();
    throw new Error(resolved.error.message);
  }
  await loadFlagConfigRoute({ ...input, flagId: resolved.data.flagId });
  return resolved.data.flagId;
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

export class FlagConfigNotFoundError extends Error {
  constructor() {
    super("SPLITCH_FLAG_NOT_FOUND");
    this.name = "FlagConfigNotFoundError";
  }
}
