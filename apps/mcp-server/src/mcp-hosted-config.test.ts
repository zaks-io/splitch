import { describe, expect, it } from "vitest";
import { handleMcpServerRequest } from "./mcp-handler";
import { createControlPlaneOperationSdk } from "./mcp-operation-sdks";
import {
  allowMcpRevocations,
  staticMcpTokenVerifier,
  TEST_MCP_DELEGATION_SECRET,
} from "./mcp-test-verifier";

const service = "splitch-mcp-server";

describe("MCP hosted configuration", () => {
  it("does not advertise localhost Auth when the platform target is unset", async () => {
    await expect(
      handleMcpServerRequest({
        request: new Request("https://mcp.test/.well-known/oauth-protected-resource"),
        service,
        tokenVerifier: staticMcpTokenVerifier(),
        revocations: allowMcpRevocations(),
      }),
    ).rejects.toThrow("SPLITCH_PLATFORM_TARGET is required");
  });

  it("does not construct a token verifier against localhost when the target is unset", async () => {
    await expect(
      handleMcpServerRequest({
        request: new Request("https://mcp.test/mcp", { method: "POST" }),
        service,
        revocations: allowMcpRevocations(),
      }),
    ).rejects.toThrow("SPLITCH_PLATFORM_TARGET is required");
  });

  it.each([
    "local",
    "pr-ci",
  ] as const)("uses the local Auth origin for %s when AUTH_API_ORIGIN is unset", async (platformTarget) => {
    const response = await handleMcpServerRequest({
      request: new Request("https://mcp.test/.well-known/oauth-protected-resource"),
      service,
      platformTarget,
      tokenVerifier: staticMcpTokenVerifier(),
      revocations: allowMcpRevocations(),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      resource: "https://mcp.test",
      authorization_servers: ["http://localhost:8791"],
    });
  });

  it("requires AUTH_API_ORIGIN on hosted targets", async () => {
    await expect(
      handleMcpServerRequest({
        request: new Request("https://mcp.test/.well-known/oauth-protected-resource"),
        service,
        platformTarget: "production",
        tokenVerifier: staticMcpTokenVerifier(),
        revocations: allowMcpRevocations(),
      }),
    ).rejects.toThrow("mcp-server: AUTH_API_ORIGIN is required for production");
  });

  it("does not send Control Plane traffic to localhost when the target is unset", () => {
    const sdk = createControlPlaneOperationSdk({
      controlPlaneFetch: async () => new Response(null, { status: 204 }),
      controlPlaneDelegationSecret: TEST_MCP_DELEGATION_SECRET,
    });
    expect(() => sdk()).toThrow("SPLITCH_PLATFORM_TARGET is required");
  });

  it.each([
    "local",
    "pr-ci",
  ] as const)("keeps the local Control Plane origin for %s", (platformTarget) => {
    const sdk = createControlPlaneOperationSdk({
      platformTarget,
      controlPlaneFetch: async () => new Response(null, { status: 204 }),
      controlPlaneDelegationSecret: TEST_MCP_DELEGATION_SECRET,
    });
    expect(sdk()).toBeTruthy();
  });

  it("requires CONTROL_PLANE_API_ORIGIN on hosted targets", () => {
    const sdk = createControlPlaneOperationSdk({
      platformTarget: "shared-preview",
      controlPlaneFetch: async () => new Response(null, { status: 204 }),
      controlPlaneDelegationSecret: TEST_MCP_DELEGATION_SECRET,
    });
    expect(() => sdk()).toThrow(
      "mcp-server: CONTROL_PLANE_API_ORIGIN is required for shared-preview",
    );
  });
});
