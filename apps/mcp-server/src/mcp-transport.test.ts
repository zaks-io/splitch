import { describe, expect, it } from "vitest";
import { memorySessionStore } from "./mcp-oauth-prm-harness";
import { routeTransportRequest } from "./mcp-transport";

const service = "splitch-mcp-server";

describe("MCP transport authenticator requirement", () => {
  it("serves health without an authenticator", async () => {
    const response = await routeTransportRequest({
      request: new Request("https://mcp.test/health"),
      service,
      platformTarget: "local",
    });

    expect(response?.status).toBe(200);
    expect(await response?.json()).toMatchObject({ service });
  });

  it.each([
    "POST",
    "DELETE",
  ] as const)("fails closed on protected %s when authenticateBearer is missing", async (method) => {
    await expect(
      routeTransportRequest({
        request: new Request("https://mcp.test/mcp", {
          method,
          headers: { authorization: "Bearer local-test-token" },
        }),
        service,
        platformTarget: "local",
        sessionStore: memorySessionStore(),
      }),
    ).rejects.toThrow("mcp-server: authenticateBearer is required");
  });
});
