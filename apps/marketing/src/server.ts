import { wrapWorkerHandler } from "@splitch/observability/worker";
import handler from "@tanstack/react-start/server-entry";

type MarketingWorkerEnv = {
  SENTRY_DSN?: string;
  SENTRY_RELEASE?: string;
  SPLITCH_PLATFORM_TARGET?: string;
};

export default wrapWorkerHandler(
  handler as unknown as ExportedHandler<MarketingWorkerEnv> &
    Required<Pick<ExportedHandler<MarketingWorkerEnv>, "fetch">>,
  { surface: "marketing" },
);
