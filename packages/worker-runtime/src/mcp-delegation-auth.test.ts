import {
  createMcpDelegationHeader,
  MCP_DELEGATION_HEADER,
  type McpDelegationReplayGuard,
} from "@splitch/contracts";
import { describe, expect, it } from "vitest";
import { makeMcpDelegationAuthResolver } from "./mcp-delegation-auth";

const SECRET = "d".repeat(32);

describe("MCP delegation auth resolver", () => {
  it("accepts an exact signed binding credential and derives tenant scope", async () => {
    const request = await delegatedRequest("https://worker.internal/apps/app_one/flags");
    await expect(resolver("control-plane-api")(request)).resolves.toEqual({
      ok: true,
      principal: {
        kind: "control-plane-token",
        id: "user_one",
        scopes: ["org:org_one:owner", "app:app_one:admin"],
        orgId: "org_one",
        appId: "app_one",
        environmentId: null,
      },
    });
  });

  it("rejects public omission, replay, and the wrong Worker owner", async () => {
    const replayGuard = memoryReplayGuard();
    const request = await delegatedRequest("https://worker.internal/apps/app_one/flags");
    await expect(resolver("analysis-api")(request)).resolves.toEqual({
      ok: false,
      reason: "UNAUTHORIZED",
    });

    const publicRequest = new Request(request);
    publicRequest.headers.delete(MCP_DELEGATION_HEADER);
    await expect(resolver("control-plane-api")(publicRequest)).resolves.toEqual({
      ok: false,
      reason: "UNAUTHORIZED",
    });

    const exactResolver = makeMcpDelegationAuthResolver({
      owner: "control-plane-api",
      secret: SECRET,
      replayGuard,
    });
    await expect(exactResolver(request)).resolves.toMatchObject({ ok: true });
    await expect(exactResolver(request)).resolves.toEqual({ ok: false, reason: "UNAUTHORIZED" });
  });
});

async function delegatedRequest(url: string): Promise<Request> {
  const request = new Request(url);
  request.headers.set(
    MCP_DELEGATION_HEADER,
    await createMcpDelegationHeader({
      operationId: "flags_list",
      actor: {
        subject: "user_one",
        scopes: ["org:org_one:owner", "app:app_one:admin"],
      },
      request,
      secret: SECRET,
    }),
  );
  return request;
}

function resolver(owner: "control-plane-api" | "analysis-api") {
  return makeMcpDelegationAuthResolver({ owner, secret: SECRET, replayGuard: memoryReplayGuard() });
}

function memoryReplayGuard(): McpDelegationReplayGuard {
  const seen = new Set<string>();
  return {
    async claim(jti) {
      if (seen.has(jti)) return false;
      seen.add(jti);
      return true;
    },
  };
}
