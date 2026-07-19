import { describe, expect, it } from "vitest";
import {
  createMcpDelegationHeader,
  MCP_DELEGATION_HEADER,
  type McpDelegationReplayGuard,
  parseMcpDelegation,
} from "./index";

const SECRET = "d".repeat(32);
const OTHER_SECRET = "e".repeat(32);

describe("MCP delegated credential", () => {
  it("signs one actor to one operation, exact target, and exact body", async () => {
    const request = new Request("https://control-plane.internal/apps/app_one/flags?limit=10");
    const credential = await createMcpDelegationHeader({
      operationId: "flags_list",
      actor: { subject: "user_one", scopes: ["app:app_one:admin"] },
      request,
      secret: SECRET,
      nowSeconds: 100,
      jti: "delegation-id-one",
    });

    await expect(
      parseMcpDelegation({
        request: withCredential(request, credential),
        owner: "control-plane-api",
        secret: SECRET,
        replayGuard: memoryReplayGuard(),
        nowSeconds: 100,
      }),
    ).resolves.toEqual({ subject: "user_one", scopes: ["app:app_one:admin"] });

    for (const changedRequest of [
      new Request("https://control-plane.internal/apps/app_two/flags?limit=10"),
      new Request("https://control-plane.internal/apps/app_one/flags?limit=11"),
      new Request("https://control-plane.internal/apps/app_one/flags?limit=10", {
        method: "POST",
        body: JSON.stringify({ appId: "app_two" }),
      }),
    ]) {
      await expect(
        parseMcpDelegation({
          request: withCredential(changedRequest, credential),
          owner: "control-plane-api",
          secret: SECRET,
          replayGuard: memoryReplayGuard(),
          nowSeconds: 100,
        }),
      ).resolves.toBeNull();
    }
  });
});

describe("MCP delegated credential rejection", () => {
  it("rejects forgery, wrong service audience, expiry, and replay", async () => {
    const request = new Request("https://control-plane.internal/apps/app_one/flags");
    const credential = await createMcpDelegationHeader({
      operationId: "flags_list",
      actor: { subject: "user_one", scopes: ["app:app_one:admin"] },
      request,
      secret: SECRET,
      nowSeconds: 100,
      jti: "delegation-id-two",
    });
    const replayGuard = memoryReplayGuard();
    const delegated = withCredential(request, credential);

    await expect(
      parseMcpDelegation({
        request: delegated,
        owner: "analysis-api",
        secret: SECRET,
        replayGuard: memoryReplayGuard(),
        nowSeconds: 100,
      }),
    ).resolves.toBeNull();
    await expect(
      parseMcpDelegation({
        request: delegated,
        owner: "control-plane-api",
        secret: OTHER_SECRET,
        replayGuard: memoryReplayGuard(),
        nowSeconds: 100,
      }),
    ).resolves.toBeNull();
    await expect(
      parseMcpDelegation({
        request: delegated,
        owner: "control-plane-api",
        secret: SECRET,
        replayGuard: memoryReplayGuard(),
        nowSeconds: 131,
      }),
    ).resolves.toBeNull();

    const options = {
      request: delegated,
      owner: "control-plane-api" as const,
      secret: SECRET,
      replayGuard,
      nowSeconds: 100,
    };
    await expect(parseMcpDelegation(options)).resolves.toEqual({
      subject: "user_one",
      scopes: ["app:app_one:admin"],
    });
    await expect(parseMcpDelegation(options)).resolves.toBeNull();

    const [payload, signature] = credential.split(".") as [string, string];
    const decoded = JSON.parse(new TextDecoder().decode(base64UrlToBytes(payload))) as Record<
      string,
      unknown
    >;
    const forgedPayload = bytesToBase64Url(
      new TextEncoder().encode(JSON.stringify({ ...decoded, subject: "attacker" })),
    );
    await expect(
      parseMcpDelegation({
        ...options,
        request: withCredential(request, `${forgedPayload}.${signature}`),
        replayGuard: memoryReplayGuard(),
      }),
    ).resolves.toBeNull();

    const unsigned = withCredential(request, payload);
    await expect(
      parseMcpDelegation({
        ...options,
        request: unsigned,
        replayGuard: memoryReplayGuard(),
      }),
    ).resolves.toBeNull();
  });

  it("rejects a signed mutation replayed with a different body", async () => {
    const request = new Request("https://control-plane.internal/apps/app_one/flags/flag_one", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "approved name" }),
    });
    const credential = await createMcpDelegationHeader({
      operationId: "flags_update",
      actor: { subject: "user_one", scopes: ["app:app_one:admin"] },
      request,
      secret: SECRET,
      nowSeconds: 100,
      jti: "delegation-id-three",
    });
    const changedBody = new Request(request.url, {
      method: request.method,
      headers: request.headers,
      body: JSON.stringify({ name: "attacker name" }),
    });

    await expect(
      parseMcpDelegation({
        request: withCredential(changedBody, credential),
        owner: "control-plane-api",
        secret: SECRET,
        replayGuard: memoryReplayGuard(),
        nowSeconds: 100,
      }),
    ).resolves.toBeNull();
  });

  it("rejects a signed request whose operation does not match its route", async () => {
    const request = new Request("https://control-plane.internal/apps/app_one/experiments");
    const credential = await createMcpDelegationHeader({
      operationId: "flags_list",
      actor: { subject: "user_one", scopes: ["app:app_one:admin"] },
      request,
      secret: SECRET,
      nowSeconds: 100,
      jti: "delegation-id-four",
    });

    await expect(
      parseMcpDelegation({
        request: withCredential(request, credential),
        owner: "control-plane-api",
        secret: SECRET,
        replayGuard: memoryReplayGuard(),
        nowSeconds: 100,
      }),
    ).resolves.toBeNull();
  });
});

function withCredential(request: Request, credential: string): Request {
  const copy = new Request(request);
  copy.headers.set(MCP_DELEGATION_HEADER, credential);
  return copy;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlToBytes(input: string): Uint8Array {
  const padded = input
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(input.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
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
