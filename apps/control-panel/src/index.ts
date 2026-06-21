import { createControlPlaneSdk } from "@splitch/control-plane-sdk";
import { createHealthResponse } from "@splitch/contracts";
import { surfaceClassName } from "@splitch/ui";

const service = "splitch-control-panel";

export default {
  async fetch(): Promise<Response> {
    const health = createHealthResponse(service);
    const sdkFactory = createControlPlaneSdk.name;

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
} satisfies ExportedHandler;
