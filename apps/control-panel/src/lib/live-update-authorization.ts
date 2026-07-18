import { createRepository } from "@splitch/db";
import type { LiveUpdateUpgradeAuthorization } from "./live-update-upgrade";
import {
  AccessDeniedError,
  resolveScopedLoaderContext,
  ScopedNotFoundError,
} from "./loader-context";
import { createEnvironmentResolver, rehydrateLegacySession } from "./membership";
import { loadSessionFromRequest } from "./session";

export interface LiveUpdateAuthorizationBindings {
  DB: D1Database;
  SESSION_STORE: KVNamespace;
}

export async function authorizeLiveUpdateUpgrade(
  request: Request,
  bindings: LiveUpdateAuthorizationBindings,
  params: { orgSlug: string; appSlug: string; env: string },
): Promise<LiveUpdateUpgradeAuthorization> {
  const loaded = await loadSessionFromRequest(bindings.SESSION_STORE, request);
  if (!loaded.ok) return { ok: false, status: 401 };

  const repo = createRepository(bindings.DB);
  const session = await rehydrateLegacySession(
    repo,
    bindings.SESSION_STORE,
    loaded.tokenHash,
    loaded.session,
  );
  try {
    const resolved = await resolveScopedLoaderContext(
      { userId: session.userId, orgs: session.orgs },
      params,
      createEnvironmentResolver(repo),
    );
    return {
      ok: true,
      scope: { ...params, ...resolved.scope },
      context: {
        version: 1,
        sessionTokenHash: loaded.tokenHash,
        userId: session.userId,
        orgId: resolved.scope.orgId,
        appId: resolved.scope.appId,
        environmentId: resolved.scope.environmentId,
        expiresAt: session.expiresAt,
      },
    };
  } catch (error) {
    if (error instanceof AccessDeniedError) return { ok: false, status: 403 };
    if (error instanceof ScopedNotFoundError) return { ok: false, status: 404 };
    throw error;
  }
}
