import { describe, expect, it } from "vitest";
import { createMcpDelegationHeader, getRoute, parseMcpDelegation } from "./index";
import {
  memoryReplayGuard,
  resignCredential,
  resultsRequest,
  SECRET,
  withCredential,
} from "./mcp-delegation-test-fixtures";

/**
 * SPL-313: MCP addressed an operation at `route.owner`, so an Analysis- or
 * Evaluation-owned tool reached that Worker directly and skipped the Control
 * Plane's membership, Environment-scope, and Policy gates. The audience is the
 * route's public surface, so a credential for an Analysis-owned operation is
 * only ever accepted by the Control Plane.
 */
describe("MCP delegated credential audience", () => {
  it("addresses a non-Control-Plane-owned operation at the Control Plane", async () => {
    const url =
      "https://control-plane.internal/apps/app_one/envs/env_one/experiments/exp_one/results";
    const request = new Request(url);
    const credential = await createMcpDelegationHeader({
      operationId: "experiment_results_get",
      actor: { subject: "user_one", scopes: ["app:app_one:admin"], authDoor: "id_jag" },
      request,
      secret: SECRET,
      nowSeconds: 100,
      jti: "delegation-id-results",
    });

    expect(getRoute("experiment_results_get")?.owner).toBe("analysis-api");
    await expect(
      parseMcpDelegation({
        request: withCredential(request, credential),
        surface: "control-plane-api",
        secret: SECRET,
        replayGuard: memoryReplayGuard(),
        nowSeconds: 100,
      }),
    ).resolves.toEqual({
      subject: "user_one",
      scopes: ["app:app_one:admin"],
      authDoor: "id_jag",
    });
    await expect(
      parseMcpDelegation({
        request: withCredential(request, credential),
        surface: "evaluation-api",
        secret: SECRET,
        replayGuard: memoryReplayGuard(),
        nowSeconds: 100,
      }),
    ).resolves.toBeNull();
  });

  it("rejects when the route surface differs even if the credential names the receiving surface", async () => {
    const request = new Request("https://control-plane.internal/apps/app_one/flags");
    const credential = await createMcpDelegationHeader({
      operationId: "flags_list",
      actor: { subject: "user_one", scopes: ["app:app_one:admin"], authDoor: "id_jag" },
      request,
      secret: SECRET,
      nowSeconds: 100,
      jti: "delegation-route-surface",
    });
    const evaluationAudience = await resignCredential(credential, {
      audience: "evaluation-api",
    });

    await expect(
      parseMcpDelegation({
        request: withCredential(request, evaluationAudience),
        surface: "evaluation-api",
        secret: SECRET,
        replayGuard: memoryReplayGuard(),
        nowSeconds: 100,
      }),
    ).resolves.toBeNull();
  });

  it("rejects when the credential audience differs even if the route names the receiving surface", async () => {
    const request = new Request("https://control-plane.internal/apps/app_one/flags");
    const credential = await createMcpDelegationHeader({
      operationId: "flags_list",
      actor: { subject: "user_one", scopes: ["app:app_one:admin"], authDoor: "id_jag" },
      request,
      secret: SECRET,
      nowSeconds: 100,
      jti: "delegation-credential-audience",
    });
    const evaluationAudience = await resignCredential(credential, {
      audience: "evaluation-api",
    });

    await expect(
      parseMcpDelegation({
        request: withCredential(request, evaluationAudience),
        surface: "control-plane-api",
        secret: SECRET,
        replayGuard: memoryReplayGuard(),
        nowSeconds: 100,
      }),
    ).resolves.toBeNull();
  });
});

describe("MCP delegated credential method binding", () => {
  it("rejects a credential minted with a request method that differs from its operation", async () => {
    const request = resultsRequest("POST");
    const credential = await createMcpDelegationHeader({
      operationId: "experiment_results_get",
      actor: { subject: "user_one", scopes: ["app:app_one:admin"], authDoor: "id_jag" },
      request,
      secret: SECRET,
      nowSeconds: 100,
      jti: "delegation-route-method",
    });

    await expect(
      parseMcpDelegation({
        request: withCredential(request, credential),
        surface: "control-plane-api",
        secret: SECRET,
        replayGuard: memoryReplayGuard(),
        nowSeconds: 100,
      }),
    ).resolves.toBeNull();
  });

  it.each([
    ["experiment_results_get", "GET", "POST"],
    ["experiment_results_post", "POST", "GET"],
  ] as const)(
    "rejects %s credentials replayed from %s as %s",
    async (operationId, minted, replayed) => {
      const request = resultsRequest(minted);
      const credential = await createMcpDelegationHeader({
        operationId,
        actor: { subject: "user_one", scopes: ["app:app_one:admin"], authDoor: "id_jag" },
        request,
        secret: SECRET,
        nowSeconds: 100,
        jti: `delegation-method-${minted.toLowerCase()}-${replayed.toLowerCase()}`,
      });

      await expect(
        parseMcpDelegation({
          request: withCredential(resultsRequest(replayed), credential),
          surface: "control-plane-api",
          secret: SECRET,
          replayGuard: memoryReplayGuard(),
          nowSeconds: 100,
        }),
      ).resolves.toBeNull();
    },
  );
});
