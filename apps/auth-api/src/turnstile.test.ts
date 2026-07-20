import { describe, expect, it, vi } from "vitest";
import {
  FIXTURE_TURNSTILE_TOKEN,
  makeCloudflareTurnstile,
  makeFixtureTurnstile,
  makeRuntimeTurnstile,
} from "./turnstile";

describe("runtime Turnstile verifier selection", () => {
  it.each([undefined, "local", "pr-ci"])(
    "keeps the fixture verifier for %s",
    async (platformTarget) => {
      const verifier = makeRuntimeTurnstile({
        fixture: makeFixtureTurnstile(),
        platformTarget,
        secret: undefined,
      });

      await expect(verifier.assertValid(FIXTURE_TURNSTILE_TOKEN, undefined)).resolves.toBe(
        undefined,
      );
    },
  );

  it.each(["shared-preview", "production"])(
    "requires TURNSTILE_SECRET for %s",
    (platformTarget) => {
      expect(() =>
        makeRuntimeTurnstile({
          fixture: makeFixtureTurnstile(),
          platformTarget,
          secret: undefined,
        }),
      ).toThrow("auth-api: TURNSTILE_SECRET is required outside local/test targets");
    },
  );

  it("fails closed for unknown explicit targets", () => {
    expect(() =>
      makeRuntimeTurnstile({
        fixture: makeFixtureTurnstile(),
        platformTarget: "staging",
        secret: "turnstile-secret",
      }),
    ).toThrow("auth-api: unsupported SPLITCH_PLATFORM_TARGET for Turnstile verifier: staging");
  });

  it("routes hosted fixture-prefixed tokens through siteverify, not the fixture verifier", async () => {
    const fetcher = vi.fn(async () =>
      Response.json({ success: false, "error-codes": ["invalid-input-response"] }),
    ) as unknown as typeof fetch;
    const verifier = makeRuntimeTurnstile({
      fetcher,
      fixture: makeFixtureTurnstile(),
      platformTarget: "shared-preview",
      secret: "turnstile-secret",
    });

    await expect(
      verifier.assertValid(`${FIXTURE_TURNSTILE_TOKEN}-hosted`, "203.0.113.10"),
    ).rejects.toMatchObject({ code: "access_denied" });
    expect(fetcher).toHaveBeenCalledOnce();
  });
});

describe("Cloudflare Turnstile siteverify adapter", () => {
  it("posts the token, secret, and remote IP as JSON", async () => {
    const fetcher = vi.fn(async () => Response.json({ success: true })) as unknown as typeof fetch;
    const verifier = makeCloudflareTurnstile({
      endpoint: "https://turnstile.test/siteverify",
      fetcher,
      secret: "turnstile-secret",
    });

    await expect(verifier.assertValid("real-token", "203.0.113.11")).resolves.toBe(undefined);

    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = vi.mocked(fetcher).mock.calls[0] ?? [];
    expect(url).toBe("https://turnstile.test/siteverify");
    expect(init).toMatchObject({
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: expect.any(AbortSignal),
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      secret: "turnstile-secret",
      response: "real-token",
      remoteip: "203.0.113.11",
    });
  });

  it("rejects failed siteverify responses with access_denied", async () => {
    const fetcher = vi.fn(async () =>
      Response.json({ success: false, "error-codes": ["timeout-or-duplicate"] }),
    ) as unknown as typeof fetch;
    const verifier = makeCloudflareTurnstile({ fetcher, secret: "turnstile-secret" });

    await expect(verifier.assertValid("expired-token", undefined)).rejects.toMatchObject({
      code: "access_denied",
    });
  });

  it("rejects malformed siteverify responses with access_denied", async () => {
    const fetcher = vi.fn(async () => Response.json(null)) as unknown as typeof fetch;
    const verifier = makeCloudflareTurnstile({ fetcher, secret: "turnstile-secret" });

    await expect(verifier.assertValid("real-token", undefined)).rejects.toMatchObject({
      code: "access_denied",
    });
  });

  it("rejects siteverify transport failures with access_denied", async () => {
    const fetcher = vi.fn(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const verifier = makeCloudflareTurnstile({ fetcher, secret: "turnstile-secret" });

    await expect(verifier.assertValid("real-token", undefined)).rejects.toMatchObject({
      code: "access_denied",
    });
  });
});
