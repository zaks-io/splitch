import { MCP_DELEGATION_HEADER, parseMcpDelegation, userRoles } from "@splitch/contracts";
import { describe, expect, it } from "vitest";
import {
  createMcpOperationAdapter,
  type McpOperationInvalidParamsError,
} from "./mcp-operation-adapter";

const app = {
  id: "app_local",
  organizationId: "org_local",
  name: "Local App",
  key: "local-app",
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-01T00:00:00.000Z",
};

describe("mcp operation adapter caller boundaries", () => {
  it("names a missing required path argument without transport vocabulary", async () => {
    const adapter = createMcpOperationAdapter({ baseUrl: "https://control-plane.test" });

    await expect(adapter.callOperationById("organizations_get", {})).rejects.toMatchObject({
      name: "McpOperationInvalidParamsError",
      argument: "orgId",
      message: 'Missing required argument "orgId".',
    } satisfies Partial<McpOperationInvalidParamsError>);
  });

  it.each(userRoles)("retains the canonical %s role while narrowing delegation", async (role) => {
    let forwardedRequest: Request | undefined;
    const adapter = createMcpOperationAdapter({
      baseUrl: "https://control-plane.test",
      delegationSecret: "d".repeat(32),
      fetch: async (request) => {
        forwardedRequest = request instanceof Request ? request : new Request(request);
        return Response.json(app);
      },
    });

    await adapter.callOperationById(
      "apps_get",
      { appId: app.id },
      {
        delegation: {
          subject: "user_mcp",
          scopes: [`app:${app.id}:${role}`],
          authDoor: "id_jag",
        },
      },
    );

    expect(forwardedRequest).toBeDefined();
    await expect(
      parseMcpDelegation({
        request: forwardedRequest as Request,
        surface: "control-plane-api",
        secret: "d".repeat(32),
        replayGuard: { claim: async () => true },
      }),
    ).resolves.toMatchObject({ scopes: [`app:${app.id}:${role}`] });
    expect(forwardedRequest?.headers.get(MCP_DELEGATION_HEADER)).not.toBeNull();
  });
});
