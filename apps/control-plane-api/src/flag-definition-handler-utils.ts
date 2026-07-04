import { appScope, type Repository, type TenantScope } from "@splitch/db";
import type { HandlerArgs } from "@splitch/worker-runtime";
import { requireAppWrite } from "./app-authz";
import { appNotFound } from "./app-environment-model";
import { flagNotFound } from "./flag-definition-errors";
import { pathParam } from "./handler-input";

export interface FlagDefinitionDeps {
  repo: Repository;
  nowIso?: () => string;
}

export type FlagRow = NonNullable<Awaited<ReturnType<Repository["flags"]["getFlag"]>>>;
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

  const writeError = await requireAppWrite(deps, appId, principal.id, requestId);
  if (writeError) return fail(writeError);
  return ok({ appId, scope, flag });
}

export async function requireWritableApp(
  deps: FlagDefinitionDeps,
  appId: string,
  userId: string,
  requestId: string,
): Promise<Response | null> {
  if (!(await deps.repo.identity.getApp(appId))) return appNotFound(requestId);
  return requireAppWrite(deps, appId, userId, requestId);
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
