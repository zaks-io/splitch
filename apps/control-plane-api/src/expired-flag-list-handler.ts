import { boundListRead } from "@splitch/contracts";
import { appScope } from "@splitch/db";
import type { HandlerArgs } from "@splitch/worker-runtime";
import { appNotFound, nowIso } from "./app-environment-model";
import type { FlagDefinitionDeps } from "./flag-definition-handler-utils";
import { flagFrom } from "./flag-definition-model";
import { pathParam } from "./handler-input";
import { FLAG_LIST_READ_LIMIT } from "./overview-thresholds";

/**
 * Flags past their `expiresAt` that still exist, most overdue first. This is
 * flag debt an agent can act on: each item names its owner, and deleting the
 * Flag is what takes it off the list.
 *
 * Bounded like the catalog read and honest about it: one row past the ceiling
 * makes truncation observed rather than inferred from a full page.
 */
export async function listExpiredFlags(
  deps: FlagDefinitionDeps,
  { input, requestId }: HandlerArgs<unknown>,
): Promise<Response> {
  const appId = pathParam(input, "appId");
  const scope = appScope(appId);
  const [app, scanned] = await Promise.all([
    deps.repo.identity.getApp(appId),
    deps.repo.flags.listExpiredFlagPage(scope, nowIso(deps), FLAG_LIST_READ_LIMIT + 1),
  ]);
  if (!app) return appNotFound(requestId);

  const {
    items: rows,
    readLimit,
    readTruncated,
    cursor,
  } = boundListRead(scanned, FLAG_LIST_READ_LIMIT);
  const catalogs = await deps.repo.flags.listVariantsForFlags(
    scope,
    rows.map((row) => row.id),
  );
  return Response.json({
    items: rows.map((row) => flagFrom(row, catalogs.get(row.id) ?? [])),
    readTruncated,
    readLimit,
    cursor,
  });
}
