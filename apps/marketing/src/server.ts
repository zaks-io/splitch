import { wrapWorkerHandler } from "@splitch/observability/worker";
import handler from "@tanstack/react-start/server-entry";
import { handleAgentSkillsRequest } from "./agent-skills";
import { withHomepageLinkHeaders } from "./agent-discovery";
import { negotiateMarkdownRequest } from "./docs/negotiate-markdown";
import { withVaryAccept } from "./docs/serve-markdown";

type MarketingWorkerEnv = {
  SENTRY_DSN?: string;
  SENTRY_RELEASE?: string;
  SPLITCH_PLATFORM_TARGET?: string;
};

const startHandler = handler as unknown as ExportedHandler<MarketingWorkerEnv> &
  Required<Pick<ExportedHandler<MarketingWorkerEnv>, "fetch">>;

const marketingHandler = {
  async fetch(request, env, ctx) {
    const agentSkillsResponse = await handleAgentSkillsRequest(request);
    if (agentSkillsResponse !== undefined) {
      return withHomepageLinkHeaders(request, agentSkillsResponse);
    }

    const negotiation = negotiateMarkdownRequest(request);
    if (negotiation.kind === "response") {
      return withHomepageLinkHeaders(request, negotiation.response);
    }

    const response = await startHandler.fetch(negotiation.request, env, ctx);
    const negotiatedResponse = response.headers.get("content-type")?.startsWith("text/html")
      ? withVaryAccept(response)
      : response;
    return withHomepageLinkHeaders(request, negotiatedResponse);
  },
} satisfies ExportedHandler<MarketingWorkerEnv>;

export default wrapWorkerHandler(marketingHandler, { surface: "marketing" });
