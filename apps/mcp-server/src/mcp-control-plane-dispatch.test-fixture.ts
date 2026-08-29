import { parseMcpDelegation } from "@splitch/contracts";
import { handleMcpServerRequest, type McpServerRequestOptions } from "./mcp-handler";
import {
  allowMcpRevocations,
  memoryMcpDelegationReplayGuard,
  staticMcpTokenVerifier,
  TEST_MCP_DELEGATION_SECRET,
} from "./mcp-test-verifier";

// Imported at module scope so the cold transform of the entire control-plane-api
// module graph lands in collection, not inside a test's timeout budget (see
// mcp-contract-errors.test.ts, which hit the same 5s default under load).
const controlPlaneAppModule = (await import(
  new URL("../../control-plane-api/src/app.ts", import.meta.url).href
)) as {
  createApp(deps: unknown): { fetch(request: Request): Promise<Response> };
};

const MISSING_BINDING_APP_ID = "app_local";
const MISSING_BINDING_ENV_ID = "env_local";
const MISSING_BINDING_EXPERIMENT_ID = "exp_local";

/**
 * Dispatches `experiment_results_post` through the real `handleMcpServerRequest`
 * -> real control-plane-api `createApp`, with the Analysis Worker's binding
 * deliberately unbound (`delegationBindings: {}`) -- exactly as an agent on the
 * MCP door would see it, and exactly the SPL-313 reviewer's reproduction.
 * Restoring the owner-naming message in delegated-routes.ts's
 * `missingOwnerBinding` must turn every caller of this red.
 * `staticMcpTokenVerifier()`'s default actor (`app:app_local:admin`) is what
 * the delegation header ends up scoped to, so the App id here has to match it.
 */
export async function missingAnalysisBindingCall(): Promise<unknown> {
  const response = await handleMcpServerRequest({
    request: new Request("https://mcp.test/mcp", {
      method: "POST",
      headers: {
        authorization: "Bearer local-test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "experiment_results_post",
          arguments: {
            appId: MISSING_BINDING_APP_ID,
            environmentId: MISSING_BINDING_ENV_ID,
            experimentId: MISSING_BINDING_EXPERIMENT_ID,
          },
        },
      }),
    }),
    service: "splitch-mcp-server",
    platformTarget: "local",
    tokenVerifier: staticMcpTokenVerifier(),
    revocations: allowMcpRevocations(),
    controlPlaneDelegationSecret: TEST_MCP_DELEGATION_SECRET,
    controlPlaneFetch: controlPlaneFetchMissingAnalysisBinding(),
  });
  return await response.json();
}

/** Mirrors mcp-contract-errors.test.ts's realControlPlaneFetch: a real
 * control-plane-api app, verifying the real signed MCP delegation header. */
function controlPlaneFetchMissingAnalysisBinding(): NonNullable<
  McpServerRequestOptions["controlPlaneFetch"]
> {
  const replayGuard = memoryMcpDelegationReplayGuard();
  const app = controlPlaneAppModule.createApp({
    authResolver: async (request: Request) => {
      const actor = await parseMcpDelegation({
        request,
        surface: "control-plane-api",
        secret: TEST_MCP_DELEGATION_SECRET,
        replayGuard,
      });
      if (!actor) return { ok: false as const, reason: "UNAUTHORIZED" as const };
      return {
        ok: true as const,
        principal: {
          kind: "control-plane-token" as const,
          id: actor.subject,
          scopes: actor.scopes,
          orgId: null,
          appId: MISSING_BINDING_APP_ID,
          environmentId: null,
        },
      };
    },
    rateLimiter: () => ({ limited: false }),
    repo: {
      identity: {
        // SPL-532 rechecks live App membership on every tenant-scoped route, so
        // the delegated actor needs the membership row its scopes claim.
        getAppMembership: async () => ({ appId: MISSING_BINDING_APP_ID, role: "admin" }),
        getEnvironment: async () => ({ id: MISSING_BINDING_ENV_ID }),
        findEnvironmentSelectorCandidates: async () => [
          {
            environmentId: MISSING_BINDING_ENV_ID,
            environmentKey: "development",
          },
        ],
      },
      experiments: {
        getExperiment: async () => ({ id: MISSING_BINDING_EXPERIMENT_ID, status: "running" }),
        listRunsForExperiment: async () => [{ id: "run_local", runNumber: 1 }],
      },
    },
    // The one binding under test: deliberately absent, so the delegated hop
    // hits missingOwnerBinding in apps/control-plane-api/src/delegated-routes.ts.
    delegationBindings: {},
  });
  return async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    return app.fetch(request);
  };
}
