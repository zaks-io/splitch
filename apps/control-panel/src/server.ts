import { addBreadcrumb, captureException, setTag, setUser } from "@sentry/cloudflare";
import { createRepository } from "@splitch/db";
import { wrapWorkerHandler } from "@splitch/observability/worker";
import handler from "@tanstack/react-start/server-entry";
import { controlPanelLiveUpdateBindings } from "#lib/bindings";
import {
  handleLiveUpdateUpgrade,
  type LiveUpdateUpgradeAuthorization,
} from "#lib/live-update-upgrade";
import {
  AccessDeniedError,
  resolveScopedLoaderContext,
  ScopedNotFoundError,
} from "#lib/loader-context";
import { createEnvironmentResolver, rehydrateLegacySession } from "#lib/membership";
import { setControlPanelSentryClient } from "#lib/panel-observability";
import { loadSessionFromRequest } from "#lib/session";

type ControlPanelWorkerEnv = {
  DB: D1Database;
  SESSION_STORE: KVNamespace;
  CONFIG_STORE_WRITER: {
    getByName(name: string): { fetch(request: Request): Promise<Response> };
  };
  WORKOS_API_KEY: string;
  WORKOS_CLIENT_ID: string;
  AUTH_API_ORIGIN: string;
  SENTRY_DSN?: string;
  SENTRY_RELEASE?: string;
  SPLITCH_PLATFORM_TARGET?: string;
};

const sentryHandler = wrapWorkerHandler(
  handler as ExportedHandler<ControlPanelWorkerEnv> &
    Required<Pick<ExportedHandler<ControlPanelWorkerEnv>, "fetch">>,
  { surface: "control-panel" },
);

export default {
  async fetch(request, env, ctx) {
    setControlPanelSentryClient({
      addBreadcrumb: (breadcrumb) => {
        addBreadcrumb(breadcrumb);
      },
      captureException: (error, context) => {
        captureException(error, context);
      },
      setTag: (key, value) => {
        setTag(key, value);
      },
      setUser: (user) => {
        setUser(user);
      },
    });
    const liveUpdateResponse = await handleLiveUpdateUpgrade(request, {
      platformTarget: env.SPLITCH_PLATFORM_TARGET,
      authorize: (upgradeRequest, params) =>
        authorizeLiveUpdateUpgrade(upgradeRequest, env, params),
      connect: (scope, upgradeRequest) =>
        controlPanelLiveUpdateBindings(env)
          .CONFIG_STORE_WRITER.getByName(`${scope.appId}:${scope.environmentId}`)
          .fetch(upgradeRequest),
    });
    return liveUpdateResponse ?? sentryHandler.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<ControlPanelWorkerEnv>;

async function authorizeLiveUpdateUpgrade(
  request: Request,
  env: ControlPanelWorkerEnv,
  params: { orgSlug: string; appSlug: string; env: string },
): Promise<LiveUpdateUpgradeAuthorization> {
  const bindings = controlPanelLiveUpdateBindings(env);
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
