import { evictDurableObject, runDurableObjectAlarm, SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { McpSessionDurableObjectNamespace } from "../src/mcp-session-store";

const namespace = (env as unknown as { MCP_SESSIONS: McpSessionDurableObjectNamespace })
  .MCP_SESSIONS;
const ownerSubject = "worker-test-user";
const foreignSubject = "worker-other-user";
let authorization = "";
let foreignAuthorization = "";

beforeAll(async () => {
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
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ keys: [{ ...publicJwk, kty: "RSA", kid: "test" }] })),
  );
  authorization = `Bearer ${await signToken(pair.privateKey, ownerSubject)}`;
  foreignAuthorization = `Bearer ${await signToken(pair.privateKey, foreignSubject)}`;
});

afterAll(() => vi.unstubAllGlobals());

describe("MCP session Worker transport", () => {
  it("preserves session context after the Durable Object isolate is evicted", async () => {
    const sessionId = await initialize();
    await useContext(sessionId);
    const stub = namespace.getByName(sessionId);

    await evictDurableObject(stub as DurableObjectStub);

    expect(await stub.getContext(Date.now(), ownerSubject)).toEqual({
      ok: true,
      value: { appId: "app_session", environmentId: "env_session" },
    });
    expect((await rpc("tools/list", undefined, sessionId)).status).toBe(200);
  });

  it("lets the owning subject resume the session until expiry", async () => {
    const sessionId = await initialize();
    await useContext(sessionId);

    const resumed = await rpc("tools/list", undefined, sessionId);
    expect(resumed.status).toBe(200);
    expect(await stubContext(sessionId, ownerSubject)).toEqual({
      appId: "app_session",
      environmentId: "env_session",
    });
  });

  it("rejects a foreign subject with the same 404 as an unknown id and leaves the session", async () => {
    const sessionId = await initialize();
    await useContext(sessionId);
    const unknownId = crypto.randomUUID();

    const foreignRead = await rpc("tools/list", undefined, sessionId, foreignAuthorization);
    const unknownRead = await rpc("tools/list", undefined, unknownId, foreignAuthorization);
    await expectOpaqueDeadSession(foreignRead);
    await expectOpaqueDeadSession(unknownRead);

    const foreignEnd = await SELF.fetch("https://mcp.test/mcp", {
      method: "DELETE",
      headers: { authorization: foreignAuthorization, "mcp-session-id": sessionId },
    });
    const unknownEnd = await SELF.fetch("https://mcp.test/mcp", {
      method: "DELETE",
      headers: { authorization: foreignAuthorization, "mcp-session-id": unknownId },
    });
    await expectOpaqueDeadSession(foreignEnd);
    await expectOpaqueDeadSession(unknownEnd);

    expect(await stubContext(sessionId, ownerSubject)).toEqual({
      appId: "app_session",
      environmentId: "env_session",
    });
    expect((await rpc("tools/list", undefined, sessionId)).status).toBe(200);
  });

  it("does not reveal or delete a session when the Durable Object subject mismatches", async () => {
    const sessionId = crypto.randomUUID();
    const stub = namespace.getByName(sessionId);
    expect(await stub.initialize(Date.now() + 60_000, ownerSubject)).toEqual({
      ok: true,
      value: undefined,
    });
    expect(
      await stub.setContext(
        { appId: "app_owner", environmentId: "env_owner" },
        Date.now(),
        ownerSubject,
      ),
    ).toEqual({
      ok: true,
      value: undefined,
    });

    const unknown = { ok: false, message: "mcp-server: MCP session is unknown or expired" };
    expect(await stub.getContext(Date.now(), foreignSubject)).toEqual(unknown);
    expect(await stub.getTransport(Date.now(), foreignSubject)).toEqual(unknown);
    expect(
      await stub.setContext(
        { appId: "app_stolen", environmentId: "env_stolen" },
        Date.now(),
        foreignSubject,
      ),
    ).toEqual(unknown);
    expect(await stub.endForSubject(Date.now(), foreignSubject)).toEqual(unknown);

    expect(await stub.getContext(Date.now(), ownerSubject)).toEqual({
      ok: true,
      value: { appId: "app_owner", environmentId: "env_owner" },
    });
  });

  it("returns 404 before dispatch after explicit session termination", async () => {
    const sessionId = await initialize();
    await useContext(sessionId);

    const ended = await SELF.fetch("https://mcp.test/mcp", {
      method: "DELETE",
      headers: { authorization, "mcp-session-id": sessionId },
    });

    expect(ended.status).toBe(204);

    const repeated = await SELF.fetch("https://mcp.test/mcp", {
      method: "DELETE",
      headers: { authorization, "mcp-session-id": sessionId },
    });
    await expectOpaqueDeadSession(repeated);
    await expectDeadSession(sessionId);
  });

  it("returns 404 before dispatch after the expiry alarm deletes context", async () => {
    const sessionId = await initialize();
    await useContext(sessionId);
    const stub = namespace.getByName(sessionId);

    await evictDurableObject(stub as DurableObjectStub);
    expect(await runDurableObjectAlarm(stub as DurableObjectStub)).toBe(true);
    await expectDeadSession(sessionId);
  });

  it("returns 404 and cleans up when transport validation observes expiry", async () => {
    const sessionId = crypto.randomUUID();
    const stub = namespace.getByName(sessionId);
    expect(await stub.initialize(Date.now() - 1, ownerSubject)).toEqual({
      ok: true,
      value: undefined,
    });

    await expectDeadSession(sessionId);
    expect(await runDurableObjectAlarm(stub as DurableObjectStub)).toBe(false);
  });

  it("returns 404 before dispatch for an unknown session", async () => {
    await expectDeadSession(crypto.randomUUID());
  });
});

async function initialize(): Promise<string> {
  const response = await rpc("initialize");
  const sessionId = response.headers.get("mcp-session-id");
  expect(response.status).toBe(200);
  expect(sessionId).toBeTruthy();
  return sessionId as string;
}

async function useContext(sessionId: string): Promise<void> {
  const response = await rpc(
    "tools/call",
    { name: "context_use", arguments: { appId: "app_session", environmentId: "env_session" } },
    sessionId,
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    result: { structuredContent: { appId: "app_session", environmentId: "env_session" } },
  });
}

async function expectDeadSession(sessionId: string): Promise<void> {
  await expectOpaqueDeadSession(
    await SELF.fetch("https://mcp.test/mcp", {
      method: "POST",
      headers: { authorization, "content-type": "application/json", "mcp-session-id": sessionId },
      body: "{malformed-dispatch-sentinel",
    }),
  );
}

async function expectOpaqueDeadSession(response: Response): Promise<void> {
  expect(response.status).toBe(404);
  expect(response.headers.get("content-type")).toBe("text/plain;charset=UTF-8");
  expect(await response.text()).toBe("MCP session not found");
}

async function stubContext(
  sessionId: string,
  subject: string,
): Promise<{ appId: string; environmentId: string } | undefined> {
  const result = await namespace.getByName(sessionId).getContext(Date.now(), subject);
  expect(result.ok).toBe(true);
  return result.ok ? result.value : undefined;
}

function rpc(
  method: string,
  params?: unknown,
  sessionId?: string,
  bearer = authorization,
): Promise<Response> {
  return SELF.fetch("https://mcp.test/mcp", {
    method: "POST",
    headers: {
      authorization: bearer,
      "content-type": "application/json",
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
}

async function signToken(key: CryptoKey, subject: string): Promise<string> {
  const header = encode({ alg: "RS256", typ: "JWT", kid: "test" });
  const payload = encode({
    typ: "access_token",
    sub: subject,
    iss: "http://localhost:8791",
    aud: "https://mcp.test/mcp",
    exp: Math.floor(Date.now() / 1000) + 3600,
    scopes: ["app:app_session:admin"],
  });
  const input = `${header}.${payload}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(input),
  );
  return `${input}.${base64Url(new Uint8Array(signature))}`;
}

function encode(value: unknown): string {
  return base64Url(new TextEncoder().encode(JSON.stringify(value)));
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
