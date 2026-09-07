import {
  noopPerformanceSpanRecorder,
  type PerformanceSpanRecorder,
} from "@splitch/observability/performance-spans";

type IntegrationKind = "convex" | "cloudflare";
type IntegrationExposureStage =
  | "configuration"
  | "identity admission"
  | "claim"
  | "ingest"
  | "confirmation"
  | "holdover";

const operationByStage = {
  configuration: "rpc.client",
  "identity admission": "auth",
  claim: "rpc.client",
  ingest: "http.client",
  confirmation: "rpc.client",
  holdover: "rpc.client",
} as const;

export function recordIntegrationExposureStage<Result>(
  recorder: PerformanceSpanRecorder | undefined,
  kind: IntegrationKind,
  stage: IntegrationExposureStage,
  run: () => Promise<Result>,
): Promise<Result> {
  const source = kind === "convex" ? "Convex" : "Cloudflare";
  return (recorder ?? noopPerformanceSpanRecorder).record(
    { name: `${source} Exposure ${stage}`, op: operationByStage[stage] },
    run,
  );
}
