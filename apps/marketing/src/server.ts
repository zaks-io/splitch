import { createHealthResponse, parsePlatformTarget } from "@splitch/contracts";
import { wrapWorkerHandler } from "@splitch/observability/worker";
import handler from "@tanstack/react-start/server-entry";
import { withHomepageLinkHeaders } from "./agent-discovery";
import { handleAgentSkillsRequest } from "./agent-skills";
import { negotiateMarkdownRequest } from "./docs/negotiate-markdown";
import { withVaryAccept } from "./docs/serve-markdown";

type MarketingWorkerEnv = {
  SPLITCH_DEPLOYED_COMMIT_SHA?: string;
  ASSETS: Fetcher;
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

    const negotiation = await negotiateMarkdownRequest(request);
    if (negotiation.kind === "response") {
      return withHomepageLinkHeaders(request, negotiation.response);
    }

    const isHomepage =
      new URL(request.url).pathname === "/" &&
      (request.method === "GET" || request.method === "HEAD");
    const response =
      isHomepage && !import.meta.env.DEV
        ? await env.ASSETS.fetch(negotiation.request)
        : await startHandler.fetch(negotiation.request, env, ctx);
    const negotiatedResponse = response.headers.get("content-type")?.startsWith("text/html")
      ? withVaryAccept(response)
      : response;
    return withHomepageLinkHeaders(request, negotiatedResponse);
  },
} satisfies ExportedHandler<MarketingWorkerEnv>;

export default wrapWorkerHandler(marketingHandler, {
  surface: "marketing",
  health: {
    paths: ["/health"],
    respond(env) {
      return Response.json(
        createHealthResponse(
          "splitch-marketing",
          parsePlatformTarget(env.SPLITCH_PLATFORM_TARGET),
          env.SPLITCH_DEPLOYED_COMMIT_SHA,
        ),
      );
    },
  },
});
