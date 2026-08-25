import {
  createWorkerFaultReporter,
  workerObservabilityWithWaitUntil,
} from "@splitch/observability/worker";
import type { ControlPlaneApiEnv } from "./env";

export function reportRunSnapshotFault(
  env: ControlPlaneApiEnv,
  ctx: Pick<ExecutionContext, "waitUntil">,
  detail: Record<string, unknown>,
): void {
  createWorkerFaultReporter(env, workerObservabilityWithWaitUntil("control-plane-api", ctx))(
    "run_snapshot_unshipped",
    detail,
  );
}
