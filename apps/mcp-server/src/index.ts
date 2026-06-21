import { createControlPlaneSdk } from "@splitch/control-plane-sdk";
import { createHealthResponse } from "@splitch/contracts";

const service = "splitch-mcp-server";

export default {
  async fetch(): Promise<Response> {
    const health = {
      ...createHealthResponse(service),
      controlPlaneSdkFactory: createControlPlaneSdk.name,
    };

    return Response.json(health);
  },
} satisfies ExportedHandler;
