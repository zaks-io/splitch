import { resolveApiDocumentVersion } from "@splitch/contracts";
import type { ControlPlaneApiEnv } from "./env";

export function apiDocumentVersion(env: ControlPlaneApiEnv): string {
  return resolveApiDocumentVersion(env.SPLITCH_PLATFORM_TARGET, env.SPLITCH_DEPLOYED_COMMIT_SHA);
}
