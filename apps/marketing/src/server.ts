import { wrapWorkerHandler } from "@splitch/observability/worker";
import handler from "@tanstack/react-start/server-entry";
import { handleAgentSkillsRequest } from "./agent-skills";
import { withHomepageLinkHeaders } from "./agent-discovery";

type MarketingWorkerEnv = {
  SENTRY_DSN?: string;
  SENTRY_RELEASE?: string;
  SPLITCH_PLATFORM_TARGET?: string;
};

const startHandler = handler as unknown as ExportedHandler<MarketingWorkerEnv> &
  Required<Pick<ExportedHandler<MarketingWorkerEnv>, "fetch">>;

export default wrapWorkerHandler(
  {
    async fetch(request, env, ctx) {
      const agentSkillsResponse = await handleAgentSkillsRequest(request);
      const response = agentSkillsResponse ?? (await startHandler.fetch(request, env, ctx));
      return withHomepageLinkHeaders(request, response);
    },
  },
  { surface: "marketing" },
);
