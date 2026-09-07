import type { Repository } from "@splitch/db";
import { describe, expect, it, vi } from "vitest";
import { processSecurityEventToken, SecurityEventError } from "./security-event-token";

const NOW_MS = 1_780_000_000_000;
const ORIGIN = "https://auth.splitch.test";
const ISSUER = "https://provider.example";
const REVOCATION_EVENT = "https://schemas.workos.com/events/agent/auth/identity/assertion/revoked";

describe("processSecurityEventToken", () => {
  it("verifies and accepts a recognized provider revocation", async () => {
    const verifyRemoteSignature = vi.fn(async () => true);
    const seenOrRecord = vi.fn(async () => false);
    const token = setToken();

    await expect(
      processSecurityEventToken(
        deps({ verifyRemoteSignature, receiptStore: { seenOrRecord } }),
        token,
      ),
    ).resolves.toEqual({ duplicate: false, recognized: true });
    expect(verifyRemoteSignature).toHaveBeenCalledWith(
      "https://provider.example/.well-known/jwks.json",
      token,
    );
    expect(seenOrRecord).toHaveBeenCalledWith(ISSUER, "set_1");
  });

  it("accepts authenticated duplicate and unknown event deliveries as no-ops", async () => {
    await expect(
      processSecurityEventToken(
        deps({ receiptStore: { seenOrRecord: async () => true } }),
        setToken({ payload: { events: { "https://schemas.example/unknown": {} } } }),
      ),
    ).resolves.toEqual({ duplicate: true, recognized: false });
  });

  it.each([
    ["wrong type", { header: { typ: "JWT" } }],
    ["missing kid", { header: { kid: undefined } }],
    ["algorithm confusion", { header: { alg: "HS256" } }],
    ["wrong audience", { payload: { aud: "https://attacker.example" } }],
    ["future issued-at", { payload: { iat: Math.floor(NOW_MS / 1000) + 61 } }],
    ["empty events", { payload: { events: {} } }],
  ])("rejects %s", async (_label, overrides) => {
    await expect(processSecurityEventToken(deps(), setToken(overrides))).rejects.toBeInstanceOf(
      SecurityEventError,
    );
  });

  it("rejects an untrusted issuer before fetching JWKS", async () => {
    const verifyRemoteSignature = vi.fn(async () => true);
    const base = deps({ verifyRemoteSignature });
    base.repo = {
      privacy: { getTrustedIdpByIssuer: async () => null },
    } as unknown as Pick<Repository, "privacy">;

    await expect(processSecurityEventToken(base, setToken())).rejects.toMatchObject({
      err: "invalid_request",
    });
    expect(verifyRemoteSignature).not.toHaveBeenCalled();
  });

  it("rejects a failed signature without recording the delivery", async () => {
    const seenOrRecord = vi.fn(async () => false);
    await expect(
      processSecurityEventToken(
        deps({ verifyRemoteSignature: async () => false, receiptStore: { seenOrRecord } }),
        setToken(),
      ),
    ).rejects.toMatchObject({ err: "invalid_request" });
    expect(seenOrRecord).not.toHaveBeenCalled();
  });
});

function deps(
  overrides: Partial<Parameters<typeof processSecurityEventToken>[0]> = {},
): Parameters<typeof processSecurityEventToken>[0] {
  return {
    repo: {
      privacy: {
        getTrustedIdpByIssuer: async (issuer: string) =>
          issuer === ISSUER
            ? {
                issuer: ISSUER,
                jwksUri: "https://provider.example/.well-known/jwks.json",
                enabled: true,
              }
            : null,
      },
    } as unknown as Pick<Repository, "privacy">,
    receiptStore: { seenOrRecord: async () => false },
    authApiOrigin: ORIGIN,
    now: () => NOW_MS,
    verifyRemoteSignature: async () => true,
    ...overrides,
  };
}

function setToken(
  overrides: { header?: Record<string, unknown>; payload?: Record<string, unknown> } = {},
): string {
  const header = {
    typ: "secevent+jwt",
    alg: "RS256",
    kid: "provider-key",
    ...overrides.header,
  };
  const payload = {
    iss: ISSUER,
    sub: "opaque-provider-subject",
    aud: ORIGIN,
    jti: "set_1",
    iat: Math.floor(NOW_MS / 1000),
    events: { [REVOCATION_EVENT]: {} },
    ...overrides.payload,
  };
  return `${encode(header)}.${encode(payload)}.${encode({ signature: true })}`;
}

function encode(value: unknown): string {
  return btoa(JSON.stringify(value)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}
