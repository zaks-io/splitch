import { createHealthResponse, parsePlatformTarget } from "@splitch/contracts";

const service = "splitch-evaluation-api";

type Env = {
  SPLITCH_PLATFORM_TARGET?: string;
};

export default {
  async fetch(_request, env): Promise<Response> {
    return Response.json(
      createHealthResponse(service, parsePlatformTarget(env.SPLITCH_PLATFORM_TARGET)),
    );
  },
} satisfies ExportedHandler<Env>;
