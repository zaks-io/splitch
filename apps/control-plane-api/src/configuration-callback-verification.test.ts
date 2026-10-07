import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { verifyConfigurationCallback } from "./configuration-callback-verification";

const SECRET = "callback-secret-for-tests";
const NOW = new Date("2026-10-06T00:00:00.000Z");
const REGISTRATION = {
  installationId: "00000000-0000-4000-8000-000000000001",
  callbackUrl: "https://gateway.chat.zaks.io/integrations/splitch/configuration",
  webhookSecret: SECRET,
};

describe("configuration callback receiver verification", () => {
  it("signs a fresh challenge and checks an independent receiver proof", async () => {
    const challenges: string[] = [];
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      const body = init?.body as string;
      const parsed = JSON.parse(body);
      expect(parsed).toEqual({
        type: "callback.verify",
        installationId: REGISTRATION.installationId,
        challenge: expect.any(String),
      });
      challenges.push(parsed.challenge);
      expect(body).not.toContain(SECRET);
      expect(headers.has("authorization")).toBe(false);
      expect(headers.get("splitch-signature")).toBe(
        `v1=${createHmac("sha256", SECRET)
          .update(`${headers.get("splitch-timestamp")}.${body}`)
          .digest("hex")}`,
      );
      return new Response(null, {
        status: 204,
        headers: {
          "splitch-callback-proof": createHmac("sha256", SECRET)
            .update(`callback.verify:${parsed.installationId}:${parsed.challenge}`)
            .digest("hex"),
        },
      });
    });
    await expect(verifyConfigurationCallback(REGISTRATION, NOW, fetcher)).resolves.toEqual({
      ok: true,
    });
    await expect(verifyConfigurationCallback(REGISTRATION, NOW, fetcher)).resolves.toEqual({
      ok: true,
    });
    expect(challenges[0]).not.toBe(challenges[1]);
  });

  it.each([null, "", "wrong-proof", "0".repeat(64)])(
    "rejects a 2xx without the right proof",
    async (proof) => {
      const response = new Response(null, {
        status: 204,
        headers: proof === null ? {} : { "splitch-callback-proof": proof },
      });
      await expect(
        verifyConfigurationCallback(REGISTRATION, NOW, async () => response),
      ).resolves.toMatchObject({ ok: false, retryable: false });
    },
  );

  it.each([
    [302, false],
    [400, false],
    [401, false],
    [429, true],
    [503, true],
  ])("classifies HTTP %s failures without reading their body", async (status, retryable) => {
    const response = new Response("secret-bearing-upstream-error", { status });
    const result = await verifyConfigurationCallback(REGISTRATION, NOW, async () => response);
    expect(result).toMatchObject({ ok: false, retryable });
    expect(JSON.stringify(result)).not.toContain("secret-bearing-upstream-error");
    expect(response.bodyUsed).toBe(false);
  });

  it("reports network errors as retryable without echoing their details", async () => {
    const result = await verifyConfigurationCallback(REGISTRATION, NOW, async () => {
      throw new Error("credential-in-network-error");
    });
    expect(result).toMatchObject({ ok: false, retryable: true });
    expect(JSON.stringify(result)).not.toContain("credential-in-network-error");
  });
});
