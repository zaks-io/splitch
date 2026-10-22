import { addBreadcrumb, captureException, setTag, setUser } from "@sentry/cloudflare";
import { createHealthResponse, parsePlatformTarget } from "@splitch/contracts";
import { wrapWorkerHandler } from "@splitch/observability/worker";
import handler from "@tanstack/react-start/server-entry";
import { createControlPanelApp } from "#lib/apps/control-plane-app-functions";
import { withControlPanelSecurityHeaders } from "#lib/auth/security-headers";
import {
  createControlPanelFlag,
  loadControlPanelFlags,
} from "#lib/flags/control-plane-flag-functions";
import { authorizeLiveUpdateUpgrade } from "#lib/live-updates/live-update-authorization";
import { handleLiveUpdateUpgrade } from "#lib/live-updates/live-update-upgrade";
import { setControlPanelSentryClient } from "#lib/observability/panel-observability";
import { loadOrgAppList } from "#lib/organizations/org-app-list-functions";
import { controlPanelLiveUpdateBindings } from "#lib/shared/bindings";
import { loadControlPanelPaletteIndex } from "#lib/shell/control-plane-palette-functions";

// Keep server functions in the Worker graph so their handlers are deployed with
// the app. Being imported by a component is not enough: the client graph can
// reference a server function without the Worker entry pulling its handler in.
void createControlPanelApp;
void createControlPanelFlag;
void loadControlPanelFlags;
void loadControlPanelPaletteIndex;
void loadOrgAppList;

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
  SPLITCH_DEPLOYED_COMMIT_SHA?: string;
  SPLITCH_LOCAL_E2E_RUN_ID?: string;
  SENTRY_DSN?: string;
  SENTRY_RELEASE?: string;
  SPLITCH_PLATFORM_TARGET?: string;
};

const startHandler = handler as unknown as ExportedHandler<ControlPanelWorkerEnv> &
  Required<Pick<ExportedHandler<ControlPanelWorkerEnv>, "fetch">>;

const controlPanelHandler = {
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
    return withControlPanelSecurityHeaders(
      liveUpdateResponse ?? (await startHandler.fetch(request, env, ctx)),
    );
  },
} satisfies ExportedHandler<ControlPanelWorkerEnv>;

export default wrapWorkerHandler(controlPanelHandler, {
  surface: "control-panel",
  health: {
    paths: ["/health"],
    respond(env) {
      const response = Response.json(
        createHealthResponse(
          "splitch-control-panel",
          parsePlatformTarget(env.SPLITCH_PLATFORM_TARGET),
          env.SPLITCH_DEPLOYED_COMMIT_SHA,
        ),
      );
      if (env.SPLITCH_LOCAL_E2E_RUN_ID) {
        response.headers.set("x-splitch-local-e2e-run-id", env.SPLITCH_LOCAL_E2E_RUN_ID);
      }
      return response;
    },
  },
});
