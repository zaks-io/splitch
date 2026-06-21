import { createHealthResponse } from "@splitch/contracts";
import { buttonClassName } from "@splitch/ui";

const service = "splitch-marketing";

export default {
  async fetch(): Promise<Response> {
    const health = createHealthResponse(service);

    return new Response(
      `<!doctype html><html lang="en"><body><main><h1>splitch</h1><p class="${buttonClassName}">${health.service}</p></main></body></html>`,
      {
        headers: {
          "content-type": "text/html; charset=utf-8",
        },
      },
    );
  },
} satisfies ExportedHandler;
