import { createMcpDelegationHeader, MCP_DELEGATION_HEADER } from "@splitch/contracts";
import { beforeAll, describe, expect, it } from "vitest";
import type { ControlPlaneApiEnv } from "../src/env.js";
import worker, { McpEntrypoint } from "../src/index.js";
import {
  AUDIENCE,
  MCP_DELEGATION_SECRET,
  OWNER,
  setupMcpDoorTestEnv,
  TENANT_A,
  testCtx,
} from "./index-mcp-fixtures.js";

let testEnv: ControlPlaneApiEnv;

beforeAll(async () => {
  testEnv = await setupMcpDoorTestEnv();
});

describe("index.ts: MCP delegation entrypoint", () => {
  it("rejects delegation publicly, accepts it once on the named entrypoint, then rejects replay", async () => {
    const request = new Request(`${AUDIENCE}/apps/${TENANT_A.appId}/flags`);
    request.headers.set(
      MCP_DELEGATION_HEADER,
      await createMcpDelegationHeader({
        operationId: "flags_list",
        actor: {
          subject: OWNER,
          scopes: [`app:${TENANT_A.appId}:admin`],
          authDoor: "id_jag",
        },
        request,
        secret: MCP_DELEGATION_SECRET,
        jti: "index-members-delegation",
      }),
    );

    const publicResponse = await worker.fetch(request.clone(), testEnv, testCtx);
    expect(publicResponse.status).toBe(401);

    const entrypoint = new McpEntrypoint(testCtx, testEnv);
    const accepted = await entrypoint.fetch(request.clone());
    expect(accepted.status).toBe(200);

    const replayed = await entrypoint.fetch(request.clone());
    expect(replayed.status).toBe(401);
  });

  it("fails closed when the delegation secret or replay binding is missing", async () => {
    const request = new Request(`${AUDIENCE}/apps/${TENANT_A.appId}/flags`);
    const missingSecret = new McpEntrypoint(testCtx, {
      ...testEnv,
      MCP_CONTROL_PLANE_DELEGATION_SECRET: undefined,
    });
    await expect(missingSecret.fetch(request.clone())).rejects.toThrow(
      "MCP_CONTROL_PLANE_DELEGATION_SECRET is required",
    );

    const missingReplay = new McpEntrypoint(testCtx, {
      ...testEnv,
      MCP_DELEGATION_REPLAY: undefined,
    });
    await expect(missingReplay.fetch(request)).rejects.toThrow("MCP_DELEGATION_REPLAY is required");
  });
});
