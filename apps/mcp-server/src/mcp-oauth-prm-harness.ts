import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { parseMcpDelegation } from "@splitch/contracts";
import { handleMcpServerRequest } from "./mcp-handler";
import { actor, NOW_SECONDS } from "./mcp-oauth-prm-actor";
import { actorClaims, signAccessToken } from "./mcp-oauth-prm-jwt";
import type {
  McpSessionContext,
  McpSessionStore,
  McpSessionTransport,
} from "./mcp-session-context";
import { McpSessionNotFoundError } from "./mcp-session-store";
import {
  allowMcpRevocations,
  memoryMcpDelegationReplayGuard,
  TEST_MCP_DELEGATION_SECRET,
} from "./mcp-test-verifier";

/**
 * Shared harness for the MCP OAuth protected-resource tests. Extracted from
 * mcp-oauth-prm.test.ts for file size; it boots the stub auth-api and
 * control-plane-api origins those tests exercise the real discovery chain
 * against.
 */

import { flagPage } from "./mcp-flag-fixtures";

const service = "splitch-mcp-server";

let cleanupServers: Array<() => Promise<void>> = [];

/** Registered by the test file's `afterEach`; the servers are booted here. */
export async function closeBootedServers(): Promise<void> {
  await Promise.all(cleanupServers.map((cleanup) => cleanup()));
  cleanupServers = [];
}

export interface JsonRpcSuccess<T> {
  result: T;
}

export interface ToolResult<T> {
  structuredContent: T;
  isError?: boolean;
}

export interface SeenRequest {
  method: string;
  path: string;
}

export interface SeenDownstream extends SeenRequest {
  authorization: string | null;
  // `authDoor` is recorded, not just `subject`/`scopes`: it is the claim the
  // Organization-creation gate keys on, so a delegation that silently upgraded
  // the door would be a privilege escalation no other assertion here would see.
  delegation: { subject: string; scopes: readonly string[]; authDoor: string } | null;
}

export async function request(
  raw: Request,
  options: {
    platformTarget?: string;
    authBaseUrl?: string;
    controlPlaneBaseUrl?: string;
    controlPlaneFetch?: typeof fetch;
    sessionStore?: McpSessionStore;
    now?: () => number;
  } = {},
): Promise<Response> {
  return handleMcpServerRequest({
    request: raw,
    service,
    controlPlaneDelegationSecret: TEST_MCP_DELEGATION_SECRET,
    revocations: allowMcpRevocations(),
    controlPlaneFetch: options.controlPlaneBaseUrl ? fetch : undefined,
    ...options,
  });
}

export async function mcp(
  method: string,
  params: unknown,
  authorization: string,
  options: {
    controlPlaneBaseUrl: string;
    controlPlaneFetch?: typeof fetch;
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

export async function bootAuthApi(seen: SeenRequest[]): Promise<{
  baseUrl: string;
  controlPlaneToken: string;
  expiredMcpToken: string;
  malformedScopeToken: string;
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
    malformedScopeToken: await signAccessToken(pair.privateKey, {
      ...actorClaims(issuer),
      aud: "https://mcp.splitch.test/mcp",
      exp: NOW_SECONDS + 60,
      scopes: ["bogus"],
    }),
  };
}

export async function bootControlPlaneApi(seen: SeenDownstream[]): Promise<string> {
  const replayGuard = memoryMcpDelegationReplayGuard();
  return bootServer(async (request, response) => {
    const authorization = request.headers.authorization ?? null;
    const delegatedRequest = new Request(`https://control-plane.internal${request.url}`, {
      method: request.method,
      headers: request.headers as HeadersInit,
    });
    const delegation = await parseMcpDelegation({
      request: delegatedRequest,
      surface: "control-plane-api",
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
      delegation.scopes.join(" ") !== actor.scopes.join(" ") ||
      delegation.authDoor !== actor.authDoor
    ) {
      writeJson(response, 401, { code: "UNAUTHORIZED", message: "UNAUTHORIZED", details: {} });
      return;
    }
    writeJson(response, 200, flagPage);
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

export function memorySessionStore(): McpSessionStore {
  const sessions = new Map<
    string,
    { context?: McpSessionContext; transport?: McpSessionTransport }
  >();
  return {
    async create(transport) {
      const id = crypto.randomUUID();
      sessions.set(id, { transport });
      return id;
    },
    async get(id) {
      if (!sessions.has(id)) throw new McpSessionNotFoundError();
      return sessions.get(id)?.context;
    },
    async getTransport(id) {
      if (!sessions.has(id)) throw new McpSessionNotFoundError();
      return sessions.get(id)?.transport;
    },
    async set(id, context) {
      if (!sessions.has(id)) throw new McpSessionNotFoundError();
      const record = sessions.get(id);
      sessions.set(id, { ...record, context });
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
