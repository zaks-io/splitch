import { addBreadcrumb, captureException, setTag, setUser } from "@sentry/cloudflare";
import { wrapWorkerHandler } from "@splitch/observability/worker";
import handler from "@tanstack/react-start/server-entry";
import { controlPanelLiveUpdateBindings } from "#lib/bindings";
import { createControlPanelApp } from "#lib/control-plane-app-functions";
import { createControlPanelFlag, loadControlPanelFlags } from "#lib/control-plane-flag-functions";
import { loadControlPanelPaletteIndex } from "#lib/control-plane-palette-functions";
import { recordLastVisitedScope } from "#lib/last-visited-scope-functions";
import { authorizeLiveUpdateUpgrade } from "#lib/live-update-authorization";
import { handleLiveUpdateUpgrade } from "#lib/live-update-upgrade";
import { loadOrgAppList } from "#lib/org-app-list-functions";
import { setControlPanelSentryClient } from "#lib/panel-observability";

// Keep server functions in the Worker graph so their handlers are deployed with
// the app. Being imported by a component is not enough: the client graph can
// reference a server function without the Worker entry pulling its handler in.
void createControlPanelApp;
void createControlPanelFlag;
void loadControlPanelFlags;
void loadControlPanelPaletteIndex;
void loadOrgAppList;
void recordLastVisitedScope;

type ControlPanelWorkerEnv = {
  DB: D1Database;
  SESSION_STORE: KVNamespace;
  CONFIG_STORE_WRITER: {
    getByName(name: string): { fetch(request: Request): Promise<Response> };
  };
  WORKOS_API_KEY: string;
  WORKOS_CLIENT_ID: string;
  AUTH_API_ORIGIN: string;
  CONTROL_PANEL_DELEGATION_SECRET: string;
  CONTROL_PLANE_API: Fetcher;
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
        authorizeLiveUpdateUpgrade(upgradeRequest, controlPanelLiveUpdateBindings(env), params),
      connect: (scope, upgradeRequest) =>
        controlPanelLiveUpdateBindings(env)
          .CONFIG_STORE_WRITER.getByName(`${scope.appId}:${scope.environmentId}`)
          .fetch(upgradeRequest),
    });
    return liveUpdateResponse ?? sentryHandler.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<ControlPanelWorkerEnv>;
