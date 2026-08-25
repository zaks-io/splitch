import { describe, expect, it, vi } from "vitest";
import { createMcpDelegationHeader, parseMcpDelegation } from "./index";
import {
  base64UrlToBytes,
  bytesToBase64Url,
  memoryReplayGuard,
  OTHER_SECRET,
  resignCredential,
  SECRET,
  withCredential,
} from "./mcp-delegation-test-fixtures";

describe("MCP delegated credential", () => {
  it("signs one actor to one operation, exact target, and exact body", async () => {
    const request = new Request("https://control-plane.internal/apps/app_one/flags?limit=10");
    const credential = await createMcpDelegationHeader({
      operationId: "flags_list",
      actor: { subject: "user_one", scopes: ["app:app_one:admin"], authDoor: "id_jag" },
      request,
      secret: SECRET,
      nowSeconds: 100,
      jti: "delegation-id-one",
    });

    // The door round-trips through the signed credential: it is covered by the
    // HMAC, so a tampered one fails the signature rather than downgrading.
    await expect(
      parseMcpDelegation({
        request: withCredential(request, credential),
        surface: "control-plane-api",
        secret: SECRET,
        replayGuard: memoryReplayGuard(),
        nowSeconds: 100,
      }),
    ).resolves.toEqual({
      subject: "user_one",
      scopes: ["app:app_one:admin"],
      authDoor: "id_jag",
    });

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
          surface: "control-plane-api",
          secret: SECRET,
          replayGuard: memoryReplayGuard(),
          nowSeconds: 100,
        }),
      ).resolves.toBeNull();
    }
  });

  it("accepts marker-less credentials long enough to preserve replay state during migration", async () => {
    const request = new Request("https://control-plane.internal/apps/app_one/flags");
    const current = await createMcpDelegationHeader({
      operationId: "flags_list",
      actor: { subject: "user_one", scopes: ["app:app_one:admin"], authDoor: "id_jag" },
      request,
      secret: SECRET,
      nowSeconds: 100,
      jti: "legacy-delegation-id",
    });
    const credential = await resignCredential(current, { replayVersion: undefined });
    const claim = vi.fn(async () => true);

    await expect(
      parseMcpDelegation({
        request: withCredential(request, credential),
        surface: "control-plane-api",
        secret: SECRET,
        replayGuard: { claim },
        nowSeconds: 100,
      }),
    ).resolves.not.toBeNull();
    expect(claim).toHaveBeenCalledWith("legacy-delegation-id", 130, 100, 1);
  });
});

describe("MCP delegated credential rejection", () => {
  it("rejects forgery, wrong service audience, expiry, and replay", async () => {
    const request = new Request("https://control-plane.internal/apps/app_one/flags");
    const credential = await createMcpDelegationHeader({
      operationId: "flags_list",
      actor: { subject: "user_one", scopes: ["app:app_one:admin"], authDoor: "id_jag" },
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
        surface: "evaluation-api",
        secret: SECRET,
        replayGuard: memoryReplayGuard(),
        nowSeconds: 100,
      }),
    ).resolves.toBeNull();
    await expect(
      parseMcpDelegation({
        request: delegated,
        surface: "control-plane-api",
        secret: OTHER_SECRET,
        replayGuard: memoryReplayGuard(),
        nowSeconds: 100,
      }),
    ).resolves.toBeNull();
    await expect(
      parseMcpDelegation({
        request: delegated,
        surface: "control-plane-api",
        secret: SECRET,
        replayGuard: memoryReplayGuard(),
        nowSeconds: 131,
      }),
    ).resolves.toBeNull();

    const options = {
      request: delegated,
      surface: "control-plane-api" as const,
      secret: SECRET,
      replayGuard,
      nowSeconds: 100,
    };
    await expect(parseMcpDelegation(options)).resolves.toEqual({
      subject: "user_one",
      scopes: ["app:app_one:admin"],
      authDoor: "id_jag",
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
      actor: { subject: "user_one", scopes: ["app:app_one:admin"], authDoor: "id_jag" },
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
        surface: "control-plane-api",
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
      actor: { subject: "user_one", scopes: ["app:app_one:admin"], authDoor: "id_jag" },
      request,
      secret: SECRET,
      nowSeconds: 100,
      jti: "delegation-id-four",
    });

    await expect(
      parseMcpDelegation({
        request: withCredential(request, credential),
        surface: "control-plane-api",
        secret: SECRET,
        replayGuard: memoryReplayGuard(),
        nowSeconds: 100,
      }),
    ).resolves.toBeNull();
  });
});

describe("MCP delegated credential shape", () => {
  it.each([
    ["missing", undefined],
    ["unrecognized", "trusted_backdoor"],
  ])("rejects a signed credential with a %s authDoor", async (_name, authDoor) => {
    const request = new Request("https://control-plane.internal/apps/app_one/flags");
    const credential = await createMcpDelegationHeader({
      operationId: "flags_list",
      actor: { subject: "user_one", scopes: ["app:app_one:admin"], authDoor: "id_jag" },
      request,
      secret: SECRET,
      nowSeconds: 100,
      jti: `delegation-auth-door-${String(authDoor)}`,
    });
    const changed = await resignCredential(credential, { authDoor });

    await expect(
      parseMcpDelegation({
        request: withCredential(request, changed),
        surface: "control-plane-api",
        secret: SECRET,
        replayGuard: memoryReplayGuard(),
        nowSeconds: 100,
      }),
    ).resolves.toBeNull();
  });
});
