import { createControlPlaneSdk } from "@splitch/control-plane-sdk";
import { createHealthResponse, parsePlatformTarget } from "@splitch/contracts";
import { surfaceClassName } from "@splitch/ui";

const service = "splitch-control-panel";

type Env = {
  SPLITCH_PLATFORM_TARGET?: string;
};

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    const health = createHealthResponse(service, parsePlatformTarget(env.SPLITCH_PLATFORM_TARGET));
    const sdkFactory = createControlPlaneSdk.name;

    if (url.pathname === "/health") {
      return Response.json(health);
    }

    return new Response(
      `<!doctype html><html lang="en"><body class="${surfaceClassName}"><pre>${JSON.stringify(
        { ...health, sdkFactory },
        null,
        2,
      )}</pre></body></html>`,
      {
        headers: {
          "content-type": "text/html; charset=utf-8",
        },
      },
    );
  },
} satisfies ExportedHandler<Env>;
