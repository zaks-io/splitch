import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { parseMcpDelegation } from "@splitch/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { handleMcpServerRequest } from "./mcp-handler";
import type { McpSessionContext, McpSessionStore } from "./mcp-session-context";
import { McpSessionNotFoundError } from "./mcp-session-store";
import {
  allowMcpRevocations,
  memoryMcpDelegationReplayGuard,
  TEST_MCP_DELEGATION_SECRET,
} from "./mcp-test-verifier";

const service = "splitch-mcp-server";
const NOW_SECONDS = 1_800_000_000;

const flagPage = {
  items: [
    {
      id: "flag_checkout",
      appId: "app_local",
      key: "checkout",
      name: "Checkout",
      variants: [{ id: "var_on", name: "on", value: true }],
      defaultVariantId: "var_on",
      createdAt: "2026-07-18T00:00:00.000Z",
      updatedAt: "2026-07-18T00:00:00.000Z",
    },
  ],
};

const actor = { subject: "user_mcp", scopes: ["app:app_local:admin"] };

let cleanupServers: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanupServers.map((cleanup) => cleanup()));
  cleanupServers = [];
});

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
        path: "/apps/app_local/flags",
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

interface JsonRpcSuccess<T> {
  result: T;
}

interface ToolResult<T> {
  structuredContent: T;
  isError?: boolean;
}

interface SeenRequest {
  method: string;
  path: string;
}

interface SeenDownstream extends SeenRequest {
  authorization: string | null;
  delegation: { subject: string; scopes: readonly string[] } | null;
}

async function request(
  raw: Request,
  options: {
    platformTarget?: string;
    authBaseUrl?: string;
    controlPlaneBaseUrl?: string;
    sessionStore?: McpSessionStore;
    now?: () => number;
  } = {},
): Promise<Response> {
  return handleMcpServerRequest({
    request: raw,
    service,
    controlPlaneDelegationSecret: TEST_MCP_DELEGATION_SECRET,
    evaluationDelegationSecret: TEST_MCP_DELEGATION_SECRET,
    analysisDelegationSecret: TEST_MCP_DELEGATION_SECRET,
    revocations: allowMcpRevocations(),
    controlPlaneFetch: options.controlPlaneBaseUrl ? fetch : undefined,
    ...options,
  });
}

async function mcp(
  method: string,
  params: unknown,
  authorization: string,
  options: {
    controlPlaneBaseUrl: string;
    sessionStore: McpSessionStore;
    sessionId?: string;
    authBaseUrl?: string;
    now?: () => number;
  },
): Promise<Response> {
  return request(
    new Request("https://mcp.splitch.test/mcp", {
      method: "POST",
      headers: {
        authorization,
        "content-type": "application/json",
        ...(options.sessionId ? { "mcp-session-id": options.sessionId } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }),
    { platformTarget: "local", ...options },
  );
}

async function bootAuthApi(seen: SeenRequest[]): Promise<{
  baseUrl: string;
  controlPlaneToken: string;
  expiredMcpToken: string;
}> {
  const pair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  let issuer = "";
  const baseUrl = await bootServer(async (request, response) => {
    seen.push({ method: request.method ?? "", path: request.url ?? "" });
    if (request.method === "GET" && request.url === "/.well-known/jwks.json") {
      writeJson(response, 200, { keys: [{ ...publicJwk, kid: "fake-auth" }] });
      return;
    }
    if (request.method !== "POST" || request.url !== "/oauth2/token") {
      writeJson(response, 404, { error: "not_found" });
      return;
    }
    writeJson(response, 200, {
      access_token: await signAccessToken(pair.privateKey, {
        ...actorClaims(issuer),
        aud: "https://mcp.splitch.test/mcp",
        exp: NOW_SECONDS + 60,
      }),
      token_type: "Bearer",
    });
  });
  issuer = baseUrl;
  return {
    baseUrl,
    controlPlaneToken: await signAccessToken(pair.privateKey, {
      ...actorClaims(issuer),
      aud: "https://api.splitch.test",
      exp: NOW_SECONDS + 60,
    }),
    expiredMcpToken: await signAccessToken(pair.privateKey, {
      ...actorClaims(issuer),
      aud: "https://mcp.splitch.test/mcp",
      exp: NOW_SECONDS - 1,
    }),
  };
}

function actorClaims(issuer: string) {
  return { typ: "access_token", sub: actor.subject, scopes: actor.scopes, iss: issuer };
}

async function signAccessToken(key: CryptoKey, claims: unknown): Promise<string> {
  const header = encodeJwtSegment({ alg: "RS256", typ: "JWT", kid: "fake-auth" });
  const payload = encodeJwtSegment(claims);
  const input = `${header}.${payload}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(input),
  );
  return `${input}.${base64Url(new Uint8Array(signature))}`;
}

function encodeJwtSegment(value: unknown): string {
  return base64Url(new TextEncoder().encode(JSON.stringify(value)));
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function bootControlPlaneApi(seen: SeenDownstream[]): Promise<string> {
  const replayGuard = memoryMcpDelegationReplayGuard();
  return bootServer(async (request, response) => {
    const authorization = request.headers.authorization ?? null;
    const delegatedRequest = new Request(`https://control-plane.internal${request.url}`, {
      method: request.method,
      headers: request.headers as HeadersInit,
    });
    const delegation = await parseMcpDelegation({
      request: delegatedRequest,
      owner: "control-plane-api",
      secret: TEST_MCP_DELEGATION_SECRET,
      replayGuard,
    });
    seen.push({
      authorization,
      delegation,
      method: request.method ?? "",
      path: request.url ?? "",
    });
    if (
      request.method !== "GET" ||
      request.url !== "/apps/app_local/flags" ||
      authorization !== null ||
      delegation?.subject !== actor.subject ||
      delegation.scopes.join(" ") !== actor.scopes.join(" ")
    ) {
      writeJson(response, 401, { code: "UNAUTHORIZED", message: "UNAUTHORIZED", details: {} });
      return;
    }
    writeJson(response, 200, { ...flagPage, cursor: null, limit: 50, total: null });
  });
}

async function bootServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>,
): Promise<string> {
  const server = createServer((request, response) => {
    void handler(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanupServers.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

function memorySessionStore(): McpSessionStore {
  const sessions = new Map<string, McpSessionContext | undefined>();
  return {
    async create() {
      const id = crypto.randomUUID();
      sessions.set(id, undefined);
      return id;
    },
    async get(id) {
      if (!sessions.has(id)) throw new McpSessionNotFoundError();
      return sessions.get(id);
    },
    async set(id, context) {
      if (!sessions.has(id)) throw new McpSessionNotFoundError();
      sessions.set(id, context);
    },
    async end(id) {
      sessions.delete(id);
    },
  };
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}
