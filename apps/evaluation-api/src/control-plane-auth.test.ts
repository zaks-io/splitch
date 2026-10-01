import { accessTokenRevocationKey, accessTokenRevocationMarker } from "@splitch/contracts";
import { describe, expect, it } from "vitest";
import { makeControlPlaneAuthResolver, makeSessionStore } from "./control-plane-auth";

const REVOKED_AT = 1_780_000_000;

function resolverWithMarker(issuedAt: number | undefined, marker: string | null) {
  const entries = new Map<string, string>();
  if (marker !== null) entries.set(accessTokenRevocationKey("user_eval"), marker);
  const kv = { get: async (key: string) => entries.get(key) ?? null } as unknown as KVNamespace;
  return makeControlPlaneAuthResolver({
    verifier: {
      verify: async () => ({
        sub: "user_eval",
        scopes: ["app:app_eval:admin"],
        authDoor: "device_flow",
        ...(issuedAt === undefined ? {} : { issuedAt }),
      }),
    },
    sessions: makeSessionStore(kv),
  });
}

function bearerRequest(): Request {
  return new Request("https://eval.splitch.test/api/flags", {
    headers: { authorization: "Bearer token" },
  });
}

describe("evaluation control-plane token revocation", () => {
  it("rejects a token issued at or before the subject's revocation", async () => {
    const resolve = resolverWithMarker(REVOKED_AT, accessTokenRevocationMarker(REVOKED_AT));

    await expect(resolve(bearerRequest())).resolves.toEqual({
      ok: false,
      reason: "CREDENTIAL_REVOKED",
    });
  });

  it("admits a token issued after the revocation", async () => {
    const resolve = resolverWithMarker(REVOKED_AT + 1, accessTokenRevocationMarker(REVOKED_AT));

    await expect(resolve(bearerRequest())).resolves.toMatchObject({ ok: true });
  });

  it("keeps a token without iat revoked while a marker exists", async () => {
    const resolve = resolverWithMarker(undefined, accessTokenRevocationMarker(REVOKED_AT));

    await expect(resolve(bearerRequest())).resolves.toEqual({
      ok: false,
      reason: "CREDENTIAL_REVOKED",
    });
  });
});
