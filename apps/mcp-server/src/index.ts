import { handleMcpServerRequest } from "./mcp-handler";

const service = "splitch-mcp-server";

type Env = {
  ANALYSIS_API?: Fetcher;
  CONTROL_PLANE_API_ORIGIN?: string;
  EVALUATION_API_ORIGIN?: string;
  ANALYSIS_API_ORIGIN?: string;
  SPLITCH_PLATFORM_TARGET?: string;
};

export default {
  async fetch(request, env): Promise<Response> {
    return handleMcpServerRequest({
      request,
      service,
      platformTarget: env.SPLITCH_PLATFORM_TARGET,
      controlPlaneBaseUrl: env.CONTROL_PLANE_API_ORIGIN,
      evaluationBaseUrl: env.EVALUATION_API_ORIGIN,
      analysisBaseUrl: env.ANALYSIS_API_ORIGIN,
      analysisFetch: serviceBindingFetch(env.ANALYSIS_API),
    });
  },
} satisfies ExportedHandler<Env>;

export { handleMcpServerRequest };

function serviceBindingFetch(service: Fetcher | undefined): typeof fetch | undefined {
  if (!service) {
    return undefined;
  }

  return async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    return service.fetch(request);
  };
}
