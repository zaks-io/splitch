import { env } from "cloudflare:workers";
import {
  CONTROL_PANEL_DELEGATION_HEADER,
  issueControlPanelDelegation,
} from "@splitch/control-plane-sdk/control-panel-identity";
import type { ControlPlaneApiEnv } from "../src/env.js";
import { SignedControlPanelEntrypoint } from "../src/index.js";

/**
 * A Results read driven through the real signed entrypoint.
 *
 * Shared so both Results route suites exercise the same wiring in
 * `src/index.ts`. A hand-rolled call per suite could keep passing while the
 * route that binds the handler to the delegation protocol was changed.
 */

export const RESULTS_AUDIENCE = "https://cp.splitch.test";
const DELEGATION_SECRET = "test-control-panel-delegation-secret-1234";
const OWNER = "user_flag_definition_owner";
const testCtx = {
  waitUntil() {},
  passThroughOnException() {},
} as unknown as ExecutionContext;

export interface PanelResultsTarget {
  appId: string;
  environmentId: string;
  experimentId: string;
  runId: string;
}

export async function callPanelResults(
  analysis: Fetcher,
  target: PanelResultsTarget,
): Promise<Response> {
  const request = new Request(`${RESULTS_AUDIENCE}/control-panel/experiments/results`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(target),
  });
  request.headers.set(
    CONTROL_PANEL_DELEGATION_HEADER,
    await issueControlPanelDelegation(
      request,
      { id: "experiments_results" },
      OWNER,
      DELEGATION_SECRET,
      { sessionExpiresAt: Math.floor(Date.now() / 1000) + 3600 },
    ),
  );

  const entrypoint = new SignedControlPanelEntrypoint(testCtx, {
    ...env,
    CONTROL_PLANE_ORIGIN: RESULTS_AUDIENCE,
    CONTROL_PANEL_DELEGATION_SECRET: DELEGATION_SECRET,
    ANALYSIS_API: analysis,
  } as ControlPlaneApiEnv);
  return entrypoint.fetch(request);
}

export function analysisReturning(response: Response): Fetcher {
  return { fetch: async () => response.clone() } as unknown as Fetcher;
}
