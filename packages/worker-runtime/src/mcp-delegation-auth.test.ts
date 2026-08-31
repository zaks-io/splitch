import {
  createMcpDelegationHeader,
  MCP_DELEGATION_HEADER,
  type McpDelegationReplayGuard,
} from "@splitch/contracts";
import { describe, expect, it, vi } from "vitest";
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
        // Carried through from the signed credential: a door that did not survive
        // delegation would leave the Worker unable to tell a provisional caller
        // from an identified one.
        authDoor: "id_jag",
      },
    });
  });

  it("carries the anonymous door through delegation without upgrading it", async () => {
    // The provisional gates key on this door, so delegation silently promoting
    // `anonymous` to an identified value would let an unclaimed principal reach
    // operations (e.g. organizations_create) it must never reach.
    const request = await delegatedRequest(
      "https://worker.internal/apps/app_one/flags",
      "anonymous",
    );
    await expect(resolver("control-plane-api")(request)).resolves.toMatchObject({
      ok: true,
      principal: { authDoor: "anonymous" },
    });
  });

  it("resolves unbounded live membership only after validating the signed delegation", async () => {
    const scopes = Array.from({ length: 70 }, (_, index) => `app:app_${index}:member`);
    const request = await delegatedRequest(
      "https://worker.internal/apps/app_one/flags",
      "device_flow",
      true,
    );
    const resolveLiveScopes = vi.fn(async () => scopes);
    const liveResolver = makeMcpDelegationAuthResolver({
      surface: "control-plane-api",
      secret: SECRET,
      replayGuard: memoryReplayGuard(),
      resolveLiveScopes,
    });

    await expect(liveResolver(request)).resolves.toMatchObject({
      ok: true,
      principal: {
        id: "user_one",
        scopes,
        liveMembership: true,
        authDoor: "device_flow",
      },
    });
    expect(resolveLiveScopes).toHaveBeenCalledWith("user_one");
  });

  it("fails loud when a live delegation reaches a Worker without a membership resolver", async () => {
    const request = await delegatedRequest(
      "https://worker.internal/apps/app_one/flags",
      "device_flow",
      true,
    );
    await expect(resolver("control-plane-api")(request)).rejects.toThrow(
      "worker-runtime: live MCP membership resolver is required",
    );
  });

  it("rejects public omission, replay, and the wrong public surface", async () => {
    const replayGuard = memoryReplayGuard();
    const request = await delegatedRequest("https://worker.internal/apps/app_one/flags");
    await expect(resolver("evaluation-api")(request)).resolves.toEqual({
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
      surface: "control-plane-api",
      secret: SECRET,
      replayGuard,
    });
    await expect(exactResolver(request)).resolves.toMatchObject({ ok: true });
    await expect(exactResolver(request)).resolves.toEqual({ ok: false, reason: "UNAUTHORIZED" });
  });
});

async function delegatedRequest(
  url: string,
  authDoor: "id_jag" | "anonymous" | "device_flow" = "id_jag",
  liveMembership = false,
): Promise<Request> {
  const request = new Request(url);
  request.headers.set(
    MCP_DELEGATION_HEADER,
    await createMcpDelegationHeader({
      operationId: "flags_list",
      actor: {
        subject: "user_one",
        scopes: liveMembership ? [] : ["org:org_one:owner", "app:app_one:admin"],
        authDoor,
        ...(liveMembership ? { liveMembership: true } : {}),
      },
      request,
      secret: SECRET,
    }),
  );
  return request;
}

function resolver(surface: "control-plane-api" | "evaluation-api") {
  return makeMcpDelegationAuthResolver({
    surface,
    secret: SECRET,
    replayGuard: memoryReplayGuard(),
  });
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
