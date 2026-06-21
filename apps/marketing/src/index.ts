import { createHealthResponse, parsePlatformTarget } from "@splitch/contracts";
import { buttonClassName } from "@splitch/ui";

const service = "splitch-marketing";

type Env = {
  SPLITCH_PLATFORM_TARGET?: string;
};

export default {
  async fetch(_request, env): Promise<Response> {
    const health = createHealthResponse(service, parsePlatformTarget(env.SPLITCH_PLATFORM_TARGET));

    return new Response(
      `<!doctype html><html lang="en"><body><main><h1>splitch</h1><p class="${buttonClassName}">${health.service}</p></main></body></html>`,
      {
        headers: {
          "content-type": "text/html; charset=utf-8",
        },
      },
    );
  },
} satisfies ExportedHandler<Env>;
