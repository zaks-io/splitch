import { appScope, type Repository, type TenantScope } from "@splitch/db";
import type { HandlerArgs } from "@splitch/worker-runtime";
import { requireAppWrite } from "./app-authz";
import { appNotFound } from "./app-environment-model";
import type { ConfigStoreAccess } from "./config-store-do";
import { flagNotFound } from "./flag-definition-errors";
import { pathParam } from "./handler-input";

export interface FlagDefinitionDeps {
  repo: Repository;
  configStore?: ConfigStoreAccess;
  logger?: Pick<Console, "warn">;
  nowIso?: () => string;
}

/**
 * Push an app-scoped Variant catalog change into every Environment's KV Flag
 * snapshot. The catalog is shared across Environments but embedded per-Environment
 * in KV, so a create/update/delete must rebuild each Environment that has a config
 * for the Flag — otherwise the data plane serves the stale Variant value forever.
 * Best-effort per Environment: D1 is the source of truth and the next config write
 * self-heals, so a KV hiccup is logged, not surfaced as a failed mutation.
 */
export async function resyncFlagSnapshots(
  deps: FlagDefinitionDeps,
  appId: string,
  flagId: string,
): Promise<void> {
  if (!deps.configStore) return;
  const envs = await deps.repo.identity.listEnvironments(appScope(appId));
  for (const env of envs) {
    try {
      await deps.configStore.writerFor(appId, env.id).resyncFlagConfig({
        appId,
        environmentId: env.id,
        flagId,
      });
    } catch (cause) {
      deps.logger?.warn("variant_catalog_kv_resync_failed", {
        appId,
        environmentId: env.id,
        flagId,
        cause,
      });
    }
  }
}

type FlagRow = NonNullable<Awaited<ReturnType<Repository["flags"]["getFlag"]>>>;
export type Result<T> = { ok: true; value: T } | { ok: false; response: Response };

export interface LoadedFlag {
  appId: string;
  scope: TenantScope;
  flag: FlagRow;
}

export async function loadWritableFlag(
  deps: FlagDefinitionDeps,
  { input, principal, requestId }: HandlerArgs<unknown>,
): Promise<Result<LoadedFlag>> {
  const appId = pathParam(input, "appId");
  const flagId = pathParam(input, "flagId");
  const scope = appScope(appId);
  const flag = await deps.repo.flags.getFlag(scope, flagId);
  if (!flag) return fail(flagNotFound(requestId));

  const writeError = await requireAppWrite(deps, appId, principal, requestId);
  if (writeError) return fail(writeError);
  return ok({ appId, scope, flag });
}

export async function requireWritableApp(
  deps: FlagDefinitionDeps,
  appId: string,
  actor: { id: string; scopes: readonly string[] },
  requestId: string,
): Promise<Response | null> {
  if (!(await deps.repo.identity.getApp(appId))) return appNotFound(requestId);
  return requireAppWrite(deps, appId, actor, requestId);
}

export function serializeSchema(schema: Record<string, unknown> | null | undefined): string | null {
  return schema === null || schema === undefined ? null : JSON.stringify(schema);
}

export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

export function fail(response: Response): Result<never> {
  return { ok: false, response };
}
