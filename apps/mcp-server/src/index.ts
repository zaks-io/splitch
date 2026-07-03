import { handleMcpServerRequest } from "./mcp-handler.js";

const service = "splitch-mcp-server";

type Env = {
  CONTROL_PLANE_API_ORIGIN?: string;
  SPLITCH_PLATFORM_TARGET?: string;
};

export default {
  async fetch(request, env): Promise<Response> {
    return handleMcpServerRequest({
      request,
      service,
      platformTarget: env.SPLITCH_PLATFORM_TARGET,
      controlPlaneBaseUrl: env.CONTROL_PLANE_API_ORIGIN,
    });
  },
} satisfies ExportedHandler<Env>;

export { handleMcpServerRequest };
