import { env } from "cloudflare:workers";
import {
  CONTROL_PANEL_DELEGATION_HEADER,
  issueControlPanelDelegation,
} from "@splitch/control-plane-sdk/control-panel-identity";
import type { ControlPlaneApiEnv } from "../src/env.js";
import { SignedControlPanelEntrypoint } from "../src/index.js";

/**
 * An Experiment detail read driven through the real signed entrypoint.
 *
 * Calling `panelExperimentDetail` directly would leave the Panel's actual
 * contract untested: the mapper could keep returning a field the delegation
 * route never reaches, or the SDK parser could reject a shape the Worker
 * happily emits, and the suite would still be green.
 */

const DETAIL_AUDIENCE = "https://cp.splitch.test";
const DELEGATION_SECRET = "test-control-panel-delegation-secret-1234";
const OWNER = "user_flag_definition_owner";
const testCtx = {
  waitUntil() {},
  passThroughOnException() {},
} as unknown as ExecutionContext;

export async function callPanelExperimentDetail(target: {
  appId: string;
  environmentId: string;
  experimentId: string;
}): Promise<Response> {
  const request = new Request(`${DETAIL_AUDIENCE}/control-panel/experiments/detail`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(target),
  });
  request.headers.set(
    CONTROL_PANEL_DELEGATION_HEADER,
    await issueControlPanelDelegation(
      request,
      { id: "experiments_detail" },
      OWNER,
      DELEGATION_SECRET,
      { sessionExpiresAt: Math.floor(Date.now() / 1000) + 3600 },
    ),
  );

  const entrypoint = new SignedControlPanelEntrypoint(testCtx, {
    ...env,
    CONTROL_PLANE_ORIGIN: DETAIL_AUDIENCE,
    CONTROL_PANEL_DELEGATION_SECRET: DELEGATION_SECRET,
  } as ControlPlaneApiEnv);
  return entrypoint.fetch(request);
}
