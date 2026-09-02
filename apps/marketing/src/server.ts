import { wrapWorkerHandler } from "@splitch/observability/worker";
import handler from "@tanstack/react-start/server-entry";
import { handleAgentSkillsRequest } from "./agent-skills";
import { withHomepageLinkHeaders } from "./agent-discovery";
import { markdownForPath } from "./docs/markdown-route";
import { acceptsMarkdown, markdownResponse, withVaryAccept } from "./docs/serve-markdown";

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

    let renderRequest = request;
    if (request.method === "GET" && acceptsMarkdown(request)) {
      const markdown = markdownForPath(new URL(request.url).pathname);
      if (markdown !== null) {
        return withHomepageLinkHeaders(request, withVaryAccept(markdownResponse(markdown)));
      }
      const headers = new Headers(request.headers);
      headers.set("accept", "text/html");
      renderRequest = new Request(request, { headers }) as typeof request;
    }

    const response = await startHandler.fetch(renderRequest, env, ctx);
    const negotiatedResponse = response.headers.get("content-type")?.startsWith("text/html")
      ? withVaryAccept(response)
      : response;
    return withHomepageLinkHeaders(request, negotiatedResponse);
  },
} satisfies ExportedHandler<MarketingWorkerEnv>;

export default wrapWorkerHandler(marketingHandler, { surface: "marketing" });
