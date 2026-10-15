import { describe, expect, it } from "vitest";
import { createMcpDelegationHeader, parseMcpDelegation } from "./index";
import {
  memoryReplayGuard,
  resignCredential,
  SECRET,
  withCredential,
} from "./mcp-delegation-test-fixtures";

describe("PAT MCP delegation", () => {
  const TOKEN_ID = `pat_${"0".repeat(32)}`;
  const TOKEN_HASH = "e".repeat(64);
  const request = () => new Request("https://control-plane.internal/apps/app_one/flags");

  it("round-trips the token id on a live personal_access_token delegation", async () => {
    const credential = await createMcpDelegationHeader({
      operationId: "flags_list",
      actor: {
        subject: "user_one",
        scopes: [],
        liveMembership: true,
        authDoor: "personal_access_token",
        personalAccessTokenId: TOKEN_ID,
        personalAccessTokenHash: TOKEN_HASH,
      },
      request: request(),
      secret: SECRET,
      nowSeconds: 100,
      jti: "delegation-id-pat-one",
    });
    await expect(
      parseMcpDelegation({
        request: withCredential(request(), credential),
        surface: "control-plane-api",
        secret: SECRET,
        replayGuard: memoryReplayGuard(),
        nowSeconds: 100,
      }),
    ).resolves.toEqual({
      subject: "user_one",
      scopes: [],
      liveMembership: true,
      authDoor: "personal_access_token",
      personalAccessTokenId: TOKEN_ID,
      personalAccessTokenHash: TOKEN_HASH,
    });
  });

  it("refuses to mint a PAT door without a token id, or a token id on another door", async () => {
    const base = { subject: "user_one", scopes: [], liveMembership: true as const };
    for (const actor of [
      { ...base, authDoor: "personal_access_token" as const },
      { ...base, authDoor: "personal_access_token" as const, personalAccessTokenId: TOKEN_ID },
      {
        ...base,
        authDoor: "device_flow" as const,
        personalAccessTokenId: TOKEN_ID,
        personalAccessTokenHash: TOKEN_HASH,
      },
      {
        subject: "user_one",
        scopes: [],
        authDoor: "personal_access_token" as const,
        personalAccessTokenId: TOKEN_ID,
        personalAccessTokenHash: TOKEN_HASH,
      },
    ]) {
      await expect(
        createMcpDelegationHeader({
          operationId: "flags_list",
          actor,
          request: request(),
          secret: SECRET,
          nowSeconds: 100,
        }),
      ).rejects.toThrow(/personal_access_token/);
    }
  });

  it("rejects a signed credential whose door and token id disagree", async () => {
    const credential = await createMcpDelegationHeader({
      operationId: "flags_list",
      actor: { subject: "user_one", scopes: [], liveMembership: true, authDoor: "device_flow" },
      request: request(),
      secret: SECRET,
      nowSeconds: 100,
    });
    for (const patch of [
      { personalAccessTokenId: TOKEN_ID, personalAccessTokenHash: TOKEN_HASH },
      { authDoor: "personal_access_token" },
      { authDoor: "personal_access_token", personalAccessTokenId: TOKEN_ID },
      {
        authDoor: "personal_access_token",
        personalAccessTokenId: "pat_short",
        personalAccessTokenHash: TOKEN_HASH,
      },
      {
        authDoor: "personal_access_token",
        personalAccessTokenId: TOKEN_ID,
        personalAccessTokenHash: "not-hex",
      },
    ]) {
      await expect(
        parseMcpDelegation({
          request: withCredential(request(), await resignCredential(credential, patch)),
          surface: "control-plane-api",
          secret: SECRET,
          replayGuard: memoryReplayGuard(),
          nowSeconds: 100,
        }),
      ).resolves.toBeNull();
    }
  });
});
