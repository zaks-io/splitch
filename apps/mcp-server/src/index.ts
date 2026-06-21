import { createControlPlaneSdk } from "@splitch/control-plane-sdk";
import { createHealthResponse, parsePlatformTarget } from "@splitch/contracts";

const service = "splitch-mcp-server";

type Env = {
  SPLITCH_PLATFORM_TARGET?: string;
};

export default {
  async fetch(_request, env): Promise<Response> {
    const health = {
      ...createHealthResponse(service, parsePlatformTarget(env.SPLITCH_PLATFORM_TARGET)),
      controlPlaneSdkFactory: createControlPlaneSdk.name,
    };

    return Response.json(health);
  },
} satisfies ExportedHandler<Env>;
