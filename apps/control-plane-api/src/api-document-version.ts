import { resolveApiDocumentVersion } from "@splitch/contracts";
import type { ControlPlaneApiEnv } from "./env";

/**
 * Which env vars carry the build identity stamped into the served OpenAPI
 * document. Named (rather than inlined at the createApp call) so the binding
 * between those two variables and `info.version` is provable without booting a
 * Worker request, the same shape as `authJwksUri`.
 */
export function apiDocumentVersion(env: ControlPlaneApiEnv): string {
  return resolveApiDocumentVersion(env.SPLITCH_PLATFORM_TARGET, env.SPLITCH_DEPLOYED_COMMIT_SHA);
}
