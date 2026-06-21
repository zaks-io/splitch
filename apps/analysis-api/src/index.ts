import { createHealthResponse, parsePlatformTarget } from "@splitch/contracts";

const service = "splitch-analysis-api";

type Env = {
  SPLITCH_PLATFORM_TARGET?: string;
};

export default {
  async fetch(_request, env): Promise<Response> {
    return Response.json(
      createHealthResponse(service, parsePlatformTarget(env.SPLITCH_PLATFORM_TARGET)),
    );
  },

  scheduled(event, _env, ctx): void {
    ctx.waitUntil(Promise.resolve(console.log(`${service}: Tinybird snapshot ${event.cron}`)));
  },
} satisfies ExportedHandler<Env>;
