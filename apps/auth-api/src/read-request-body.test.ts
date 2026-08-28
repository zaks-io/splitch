import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppDeps } from "./app";
import { createApp } from "./app";
import { form, routeApp, unusedRefreshStore } from "./oauth-route-test-harness";
import { AUTH_REQUEST_MAX_BODY_BYTES } from "./read-request-body";
import type { TokenSigner } from "./token-exchange";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Auth standalone body bound", () => {
  it("rejects a declared over-limit OAuth form before grant parsing", async () => {
    const app = routeApp({
      deviceFlow: unusedDeviceFlow(),
      deviceRefreshSessions: unusedRefreshStore,
    });
    const body = controlledBody(["must-not-be-read"]);

    const response = await app.request(
      requestWithBody("/oauth2/token", body.stream, {
        "content-type": "application/x-www-form-urlencoded",
        "content-length": String(AUTH_REQUEST_MAX_BODY_BYTES + 1),
      }),
    );

    expect(body.pull).not.toHaveBeenCalled();
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "invalid_request",
      error_description: "request body is too large",
    });
  });

  it("stops a chunked over-limit OAuth form at the first over-cap byte", async () => {
    const rejectedMarker = "must-never-be-read-or-logged";
    const app = routeApp({
      deviceFlow: unusedDeviceFlow(),
      deviceRefreshSessions: unusedRefreshStore,
    });
    const body = controlledBody(["x".repeat(AUTH_REQUEST_MAX_BODY_BYTES), "y", rejectedMarker]);

    const response = await app.request(
      requestWithBody("/oauth2/token", body.stream, {
        "content-type": "application/x-www-form-urlencoded",
        "content-length": "not-a-number",
      }),
    );

    expect(body.pull).toHaveBeenCalledTimes(2);
    expect(body.cancel).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: "invalid_request",
      error_description: "request body is too large",
    });
  });

  it("accepts an at-limit JSON token body and still applies OAuth semantics", async () => {
    const app = routeApp({
      deviceFlow: unusedDeviceFlow(),
      deviceRefreshSessions: unusedRefreshStore,
    });
    const raw = atCapJson({ grant_type: "password" }, AUTH_REQUEST_MAX_BODY_BYTES);

    const response = await app.request("/oauth2/token", {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: raw,
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "unsupported_grant_type" });
  });

  it("rejects an unsupported OAuth content type without parsing", async () => {
    const parse = vi.spyOn(JSON, "parse");
    const app = routeApp({
      deviceFlow: unusedDeviceFlow(),
      deviceRefreshSessions: unusedRefreshStore,
    });

    const response = await app.request("/oauth2/token", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "grant_type=password",
    });

    expect(parsedRequestBodies(parse, "grant_type")).toEqual([]);
    parse.mockRestore();
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "invalid_request",
      error_description: "unsupported content type",
    });
  });

  it("keeps malformed under-cap JSON on the existing OAuth invalid_request path", async () => {
    const app = routeApp({
      deviceFlow: unusedDeviceFlow(),
      deviceRefreshSessions: unusedRefreshStore,
    });

    const response = await app.request("/oauth2/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "}{",
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: "invalid_request",
      error_description: "malformed /oauth2/token body",
    });
  });

  it("rejects a declared over-limit /agent/identity JSON body before door routing", async () => {
    const app = identityApp();
    const body = controlledBody(["must-not-be-read"]);

    const response = await app.request(
      requestWithBody("/agent/identity", body.stream, {
        "content-type": "application/json",
        "content-length": String(AUTH_REQUEST_MAX_BODY_BYTES + 1),
      }),
    );

    expect(body.pull).not.toHaveBeenCalled();
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "invalid_request",
      error_description: "request body is too large",
    });
  });

  it("still accepts a bounded OAuth form post", async () => {
    const app = routeApp({
      deviceFlow: unusedDeviceFlow(),
      deviceRefreshSessions: unusedRefreshStore,
    });

    const response = await app.request("/oauth2/revoke", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form({
        client_id: "splitch-cli",
        token: "unknown-refresh-token",
        token_type_hint: "refresh_token",
      }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_grant" });
  });
});

function identityApp() {
  return createApp({
    repo: {} as AppDeps["repo"],
    accessSecret: "test-access-secret",
    controlPlaneAudience: "https://cp.splitch.test",
    now: () => 1_780_000_000_000,
    idJag: {} as AppDeps["idJag"],
    tokenSigner: {
      mintIdentityAssertion: vi.fn(),
      exchangeForAccessToken: vi.fn(),
      verifyIdentityAssertion: vi.fn(),
      mintAccessToken: vi.fn(),
    } as unknown as TokenSigner,
    register: {} as AppDeps["register"],
    claim: {} as AppDeps["claim"],
    deviceFlow: {} as AppDeps["deviceFlow"],
    deviceRefreshSessions: {} as AppDeps["deviceRefreshSessions"],
    sessionStore: {} as AppDeps["sessionStore"],
    revocations: {} as AppDeps["revocations"],
  });
}

function unusedDeviceFlow() {
  return {
    authorizeDevice: async () => {
      throw new Error("device flow must not run");
    },
    exchangeDeviceCode: async () => {
      throw new Error("device flow must not run");
    },
    refreshProviderToken: async () => {
      throw new Error("device flow must not run");
    },
    revokeProviderToken: async () => {
      throw new Error("device flow must not run");
    },
  };
}

function controlledBody(chunks: readonly string[]) {
  const remaining = [...chunks];
  const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => {
    const chunk = remaining.shift();
    if (chunk === undefined) {
      controller.close();
      return;
    }
    controller.enqueue(new TextEncoder().encode(chunk));
  });
  const cancel = vi.fn();
  return {
    stream: new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 }),
    pull,
    cancel,
  };
}

function requestWithBody(
  path: string,
  body: ReadableStream<Uint8Array>,
  headers: Record<string, string>,
): Request {
  return new Request(`http://auth.test${path}`, {
    method: "POST",
    headers,
    body,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
}

function parsedRequestBodies(parse: { mock: { calls: unknown[][] } }, prefix: string): string[] {
  return parse.mock.calls
    .map((call) => call[0])
    .filter((value): value is string => typeof value === "string" && value.startsWith(prefix));
}

function atCapJson(fields: Record<string, string>, maxBytes: number): string {
  const body = JSON.stringify({ ...fields, pad: "" });
  const pad = maxBytes - new TextEncoder().encode(body).length;
  if (pad < 0) throw new Error("fixture exceeds target byte length");
  return JSON.stringify({ ...fields, pad: "a".repeat(pad) });
}
