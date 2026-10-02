import type { FlagDefinitionPatch } from "@splitch/db";
import { flagNotFound } from "./flag-definition-errors";
import type { FlagDefinitionDeps, LoadedFlag } from "./flag-definition-handler-utils";
import { flagResponse } from "./flag-definition-model";
import { patchLifecycle } from "./flag-lifecycle";

const LIFECYCLE_WRITE_ATTEMPTS = 3;

/**
 * Writes a `flags_update` patch. The D9 rule is checked against the row as
 * read and a lifecycle write is conditioned on that row, so a concurrent
 * lifecycle change makes this re-read and re-check instead of landing a
 * combination neither caller was allowed to make.
 */
export async function writeFlagPatch(
  deps: FlagDefinitionDeps,
  loaded: LoadedFlag,
  body: Record<string, unknown>,
  fields: FlagDefinitionPatch,
  requestId: string,
): Promise<Response> {
  let current: LoadedFlag["flag"] | null = loaded.flag;
  for (let attempt = 0; attempt < LIFECYCLE_WRITE_ATTEMPTS; attempt += 1) {
    if (!current) return flagNotFound(requestId);
    const written = await attemptWrite(deps, loaded, current, body, fields, requestId);
    if (written) return written;
    current = await deps.repo.flags.getFlag(loaded.scope, current.id);
  }
  throw new Error(`flags_update: Flag ${loaded.flag.id} lifecycle kept changing under the write`);
}

/** The response, or null when a guarded lifecycle write lost to a concurrent one. */
async function attemptWrite(
  deps: FlagDefinitionDeps,
  loaded: LoadedFlag,
  current: LoadedFlag["flag"],
  body: Record<string, unknown>,
  fields: FlagDefinitionPatch,
  requestId: string,
): Promise<Response | null> {
  const lifecycle = patchLifecycle(current, body, requestId);
  if (!lifecycle.ok) return lifecycle.response;
  const updated = await deps.repo.flags.updateFlag(
    loaded.scope,
    current.id,
    { ...fields, ...lifecycle.value },
    lifecycle.value ? current : undefined,
  );
  if (updated) return Response.json(await flagResponse(deps.repo, loaded.appId, updated));
  return lifecycle.value ? null : flagNotFound(requestId);
}
