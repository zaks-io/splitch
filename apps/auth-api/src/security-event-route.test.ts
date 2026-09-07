import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { mountSecurityEventRoute, SECURITY_EVENT_TOKEN_MAX_BYTES } from "./security-event-route";
import type { SecurityEventDeps } from "./security-event-token";

describe("security event route", () => {
  it("accepts a bounded provider SET with an empty 202", async () => {
    const app = new Hono();
    mountSecurityEventRoute(app, acceptingDeps());
    const response = await app.request("/agent/event/notify", {
      method: "POST",
      headers: { "content-type": "application/secevent+jwt" },
      body: setToken(),
    });

    expect(response.status).toBe(202);
    expect(await response.text()).toBe("");
  });

  it.each([
    ["wrong media type", { "content-type": "application/json" }],
    [
      "declared overflow",
      {
        "content-type": "application/secevent+jwt",
        "content-length": String(SECURITY_EVENT_TOKEN_MAX_BYTES + 1),
      },
    ],
  ])("returns the RFC 8935 error shape for %s", async (_label, headers) => {
    const app = new Hono();
    mountSecurityEventRoute(app, acceptingDeps());
    const response = await app.request("/agent/event/notify", {
      method: "POST",
      headers,
      body: setToken(),
    });

    expect(response.status).toBe(400);
    expect(response.headers.get("content-language")).toBe("en");
    expect(await response.json()).toMatchObject({ err: "invalid_request" });
  });

  it("cancels a streamed SET when it crosses the byte cap", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(SECURITY_EVENT_TOKEN_MAX_BYTES));
        controller.enqueue(new Uint8Array([1]));
      },
      cancel() {
        cancelled = true;
      },
    });
    const app = new Hono();
    mountSecurityEventRoute(app, acceptingDeps());
    const response = await app.request(
      new Request("https://auth.splitch.test/agent/event/notify", {
        method: "POST",
        headers: { "content-type": "application/secevent+jwt" },
        body: stream,
        duplex: "half",
      } as RequestInit & { duplex: "half" }),
    );

    expect(response.status).toBe(400);
    expect(cancelled).toBe(true);
  });
});

function acceptingDeps(): SecurityEventDeps {
  return {
    repo: {
      privacy: {
        getTrustedIdpByIssuer: async () => ({
          enabled: true,
          jwksUri: "https://provider.example/.well-known/jwks.json",
        }),
      },
    } as unknown as SecurityEventDeps["repo"],
    receiptStore: { seenOrRecord: async () => false },
    authApiOrigin: "https://auth.splitch.test",
    now: () => 1_780_000_000_000,
    verifyRemoteSignature: async () => true,
  };
}

function setToken(): string {
  const encode = (value: unknown) =>
    btoa(JSON.stringify(value)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
  return `${encode({ typ: "secevent+jwt", alg: "RS256", kid: "key" })}.${encode({
    iss: "https://provider.example",
    sub: "subject",
    aud: "https://auth.splitch.test",
    jti: "set_1",
    iat: 1_780_000_000,
    events: { "https://schemas.example/unknown": {} },
  })}.${encode({ signature: true })}`;
}
