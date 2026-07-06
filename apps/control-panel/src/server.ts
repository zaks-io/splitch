import { addBreadcrumb, captureException, setTag, setUser } from "@sentry/cloudflare";
import { wrapWorkerHandler } from "@splitch/observability/worker";
import handler from "@tanstack/react-start/server-entry";
import { setControlPanelSentryClient } from "#lib/panel-observability";

type ControlPanelWorkerEnv = {
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
  fetch(request, env, ctx) {
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
    return sentryHandler.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<ControlPanelWorkerEnv>;
