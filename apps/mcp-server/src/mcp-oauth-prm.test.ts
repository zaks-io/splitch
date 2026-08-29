import { afterEach, describe, expect, it } from "vitest";
import { flagPage } from "./mcp-flag-fixtures";
import { actor, NOW_SECONDS } from "./mcp-oauth-prm-actor";
import {
  bootAuthApi,
  bootControlPlaneApi,
  closeBootedServers,
  type JsonRpcSuccess,
  mcp,
  memorySessionStore,
  request,
  type SeenDownstream,
  type SeenRequest,
  type ToolResult,
} from "./mcp-oauth-prm-harness";
import { actorClaims, encodeJwtSegment, malformedShapeTokens } from "./mcp-oauth-prm-jwt";

afterEach(closeBootedServers);

describe("MCP OAuth protected-resource boundary", () => {
  it("challenges an unauthenticated connect with discoverable protected-resource metadata", async () => {
    for (const [path, metadataPath] of [
      ["/", "/.well-known/oauth-protected-resource"],
      ["/mcp", "/.well-known/oauth-protected-resource/mcp"],
    ]) {
      const response = await request(
        new Request(`https://mcp.splitch.test${path}`, { method: "POST" }),
      );

      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toBe(
        `Bearer realm="splitch", resource_metadata="https://mcp.splitch.test${metadataPath}"`,
      );
    }
  });

  it("rejects malformed bearer credentials at the transport boundary", async () => {
    for (const authorization of ["Token opaque", "Bearer", "Bearer   "]) {
      const response = await request(
        new Request("https://mcp.splitch.test/mcp", {
          method: "POST",
          headers: { authorization },
        }),
      );
      expect(response.status).toBe(401);
    }
  });

  it("returns 401 for malformed JWT JSON shapes without downstream dispatch", async () => {
    let downstreamCalls = 0;

    for (const token of malformedShapeTokens()) {
      const response = await request(
        new Request("https://mcp.splitch.test/mcp", {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name: "flags_list", arguments: { appId: "app_local" } },
          }),
        }),
        {
          authBaseUrl: "https://auth.splitch.test",
          controlPlaneFetch: async () => {
            downstreamCalls += 1;
            return Response.json(flagPage);
          },
        },
      );
      expect(response.status).toBe(401);
    }

    expect(downstreamCalls).toBe(0);
  });

  it("serves same-target Auth API metadata for preview and production", async () => {
    for (const target of [
      ["shared-preview", "https://auth.preview.splitch.dev"],
      ["production", "https://auth.splitch.dev"],
    ] as const) {
      const response = await request(
        new Request("https://mcp.splitch.test/.well-known/oauth-protected-resource"),
        { platformTarget: target[0], authBaseUrl: target[1] },
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        resource: "https://mcp.splitch.test",
        authorization_servers: [target[1]],
      });
    }
  });

  it("identifies each challenged MCP endpoint as the protected resource", async () => {
    const rootMetadata = await request(
      new Request("https://mcp.splitch.test/.well-known/oauth-protected-resource"),
    );
    const mcpMetadata = await request(
      new Request("https://mcp.splitch.test/.well-known/oauth-protected-resource/mcp"),
    );

    await expect(rootMetadata.json()).resolves.toMatchObject({
      resource: "https://mcp.splitch.test",
    });
    await expect(mcpMetadata.json()).resolves.toMatchObject({
      resource: "https://mcp.splitch.test/mcp",
    });
  });

  it("accepts an MCP-audience token and dispatches with a separate one-call delegation", async () => {
    const authRequests: SeenRequest[] = [];
    const auth = await bootAuthApi(authRequests);
    const seenDownstream: SeenDownstream[] = [];
    const controlPlaneBaseUrl = await bootControlPlaneApi(seenDownstream);
    const tokenResponse = await fetch(`${auth.baseUrl}/oauth2/token`, { method: "POST" });
    const token = ((await tokenResponse.json()) as { access_token: string }).access_token;
    expect(authRequests).toEqual([{ method: "POST", path: "/oauth2/token" }]);
    const sessionStore = memorySessionStore();

    const initialize = await mcp("initialize", undefined, `Bearer ${token}`, {
      controlPlaneBaseUrl,
      sessionStore,
      authBaseUrl: auth.baseUrl,
      now: () => NOW_SECONDS * 1000,
    });
    const sessionId = initialize.headers.get("mcp-session-id");
    expect(sessionId).toBeTruthy();

    const accepted = await mcp(
      "tools/call",
      { name: "flags_list", arguments: { appId: "app_local" } },
      `Bearer ${token}`,
      {
        controlPlaneBaseUrl,
        sessionStore,
        sessionId: sessionId ?? undefined,
        authBaseUrl: auth.baseUrl,
        now: () => NOW_SECONDS * 1000,
      },
    );
    const acceptedBody = (await accepted.json()) as JsonRpcSuccess<ToolResult<typeof flagPage>>;
    expect(acceptedBody.result.structuredContent).toEqual(flagPage);

    expect(seenDownstream).toEqual([
      {
        authorization: null,
        delegation: actor,
        method: "GET",
        path: "/apps/app_local/flags?include=config",
      },
    ]);

    const jwtShapedMalformedToken = `${encodeJwtSegment({
      alg: "RS256",
      typ: "JWT",
      kid: "fake-auth",
    })}.${encodeJwtSegment({
      ...actorClaims(auth.baseUrl),
      aud: "https://mcp.splitch.test/mcp",
      exp: NOW_SECONDS + 60,
    })}.%%%`;
    for (const rejectedToken of [
      auth.controlPlaneToken,
      auth.expiredMcpToken,
      jwtShapedMalformedToken,
      "garbage-token",
    ]) {
      const rejected = await mcp(
        "tools/call",
        { name: "flags_list", arguments: { appId: "app_local" } },
        `Bearer ${rejectedToken}`,
        {
          controlPlaneBaseUrl,
          sessionStore,
          authBaseUrl: auth.baseUrl,
          now: () => NOW_SECONDS * 1000,
        },
      );
      expect(rejected.status).toBe(401);
    }
    expect(seenDownstream).toHaveLength(1);
  });
});

describe("MCP held-scope authentication boundary", () => {
  it("returns 401 for a correctly signed malformed scope without downstream dispatch", async () => {
    const auth = await bootAuthApi([]);
    let downstreamCalls = 0;

    const response = await mcp(
      "tools/call",
      { name: "flags_list", arguments: { appId: "app_local" } },
      `Bearer ${auth.malformedScopeToken}`,
      {
        controlPlaneBaseUrl: "https://control-plane.splitch.test",
        controlPlaneFetch: async () => {
          downstreamCalls += 1;
          return Response.json(flagPage);
        },
        sessionStore: memorySessionStore(),
        authBaseUrl: auth.baseUrl,
        now: () => NOW_SECONDS * 1000,
      },
    );

    expect(response.status).toBe(401);
    expect(downstreamCalls).toBe(0);
  });
});
