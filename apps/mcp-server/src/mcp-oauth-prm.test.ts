import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { ErrorResponse } from "@splitch/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { handleMcpServerRequest } from "./mcp-handler";
import type { McpSessionContext, McpSessionStore } from "./mcp-session-context";
import { McpSessionNotFoundError } from "./mcp-session-store";

const service = "splitch-mcp-server";
const issuedToken = "fake-issued-control-plane-token";

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

const unauthorized: ErrorResponse = {
  code: "UNAUTHORIZED",
  message: "invalid or expired control-plane token",
  details: {},
};

let cleanupServers: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanupServers.map((cleanup) => cleanup()));
  cleanupServers = [];
});

describe("MCP OAuth protected-resource boundary", () => {
  it("challenges an unauthenticated connect with discoverable protected-resource metadata", async () => {
    const response = await request(new Request("https://mcp.splitch.test/mcp", { method: "POST" }));

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe(
      'Bearer realm="splitch" resource_metadata_url="https://mcp.splitch.test/.well-known/oauth-protected-resource"',
    );
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

  it("forwards the current bearer on every call and never widens session authority", async () => {
    const authRequests: SeenRequest[] = [];
    const authBaseUrl = await bootAuthApi(authRequests);
    const seenAuthorization: Array<string | null> = [];
    const controlPlaneBaseUrl = await bootControlPlaneApi(seenAuthorization);
    const tokenResponse = await fetch(`${authBaseUrl}/oauth2/token`, { method: "POST" });
    const token = ((await tokenResponse.json()) as { access_token: string }).access_token;
    expect(authRequests).toEqual([{ method: "POST", path: "/oauth2/token" }]);
    const sessionStore = memorySessionStore();

    const initialize = await mcp("initialize", undefined, `Bearer ${token}`, {
      controlPlaneBaseUrl,
      sessionStore,
    });
    const sessionId = initialize.headers.get("mcp-session-id");
    expect(sessionId).toBeTruthy();

    const accepted = await mcp(
      "tools/call",
      { name: "flags_list", arguments: { appId: "app_local" } },
      `Bearer ${token}`,
      { controlPlaneBaseUrl, sessionStore, sessionId: sessionId ?? undefined },
    );
    const acceptedBody = (await accepted.json()) as JsonRpcSuccess<ToolResult<typeof flagPage>>;
    expect(acceptedBody.result.structuredContent).toEqual(flagPage);

    for (const rejectedToken of ["expired-control-plane-token", "garbage-token"]) {
      const rejected = await mcp(
        "tools/call",
        { name: "flags_list", arguments: { appId: "app_local" } },
        `Bearer ${rejectedToken}`,
        { controlPlaneBaseUrl, sessionStore, sessionId: sessionId ?? undefined },
      );
      const rejectedBody = (await rejected.json()) as JsonRpcSuccess<ToolResult<ErrorResponse>>;
      expect(rejectedBody.result.isError).toBe(true);
      expect(rejectedBody.result.structuredContent).toEqual(unauthorized);
    }

    expect(seenAuthorization).toEqual([
      `Bearer ${issuedToken}`,
      "Bearer expired-control-plane-token",
      "Bearer garbage-token",
    ]);
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

async function request(
  raw: Request,
  options: {
    platformTarget?: string;
    authBaseUrl?: string;
    controlPlaneBaseUrl?: string;
    sessionStore?: McpSessionStore;
  } = {},
): Promise<Response> {
  return handleMcpServerRequest({ request: raw, service, ...options });
}

async function mcp(
  method: string,
  params: unknown,
  authorization: string,
  options: {
    controlPlaneBaseUrl: string;
    sessionStore: McpSessionStore;
    sessionId?: string;
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

async function bootAuthApi(seen: SeenRequest[]): Promise<string> {
  return bootServer((request, response) => {
    seen.push({ method: request.method ?? "", path: request.url ?? "" });
    if (request.method !== "POST" || request.url !== "/oauth2/token") {
      writeJson(response, 404, { error: "not_found" });
      return;
    }
    writeJson(response, 200, { access_token: issuedToken, token_type: "Bearer" });
  });
}

async function bootControlPlaneApi(seenAuthorization: Array<string | null>): Promise<string> {
  return bootServer((request, response) => {
    const authorization = request.headers.authorization ?? null;
    seenAuthorization.push(authorization);
    if (
      request.method !== "GET" ||
      request.url !== "/apps/app_local/flags" ||
      authorization !== `Bearer ${issuedToken}`
    ) {
      writeJson(response, 401, unauthorized);
      return;
    }
    writeJson(response, 200, { ...flagPage, cursor: null, limit: 50, total: null });
  });
}

async function bootServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<string> {
  const server = createServer(handler);
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
