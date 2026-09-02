import {
  noopPerformanceSpanRecorder,
  type PerformanceSpanRecorder,
} from "@splitch/observability/performance-spans";

export async function fetchAnalysis(
  analysis: Pick<Fetcher, "fetch">,
  request: Request,
  operation: "results_read" | "exposure_status_delete",
  spanRecorder: PerformanceSpanRecorder = noopPerformanceSpanRecorder,
): Promise<Response> {
  return spanRecorder.record(
    {
      name: `Analysis ${operation}`,
      op: "rpc.client",
      attributes: {
        "rpc.system": "cloudflare.service_binding",
        "rpc.method": operation,
      },
    },
    async (span) => {
      const response = await analysis.fetch(request);
      span.setAttribute("rpc.response.status_code", response.status);
      return response;
    },
  );
}
