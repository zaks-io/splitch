import { afterEach, describe, expect, it, vi } from "vitest";
import { remoteJwksSignatureVerifier } from "./remote-jwks";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("remote JWKS signature verification", () => {
  it("reuses the fetched key set and refreshes after a rotated kid", async () => {
    const first = await keypair("first");
    const second = await keypair("second");
    let jwks = first.jwks;
    const fetchJwks = vi.fn(async () => Response.json(jwks));
    vi.stubGlobal("fetch", fetchJwks);
    vi.useFakeTimers({ now: new Date("2026-08-25T12:00:00.000Z") });
    const verifier = remoteJwksSignatureVerifier(uniqueJwksUri());
    const firstToken = await sign(first, { sub: "user_first" });

    await expect(verifier.verify(firstToken)).resolves.toBe(true);
    await expect(verifier.verify(firstToken)).resolves.toBe(true);
    expect(fetchJwks).toHaveBeenCalledOnce();

    jwks = second.jwks;
    vi.advanceTimersByTime(30_001);
    await expect(verifier.verify(await sign(second, { sub: "user_second" }))).resolves.toBe(true);
    expect(fetchJwks).toHaveBeenCalledTimes(2);
  });

  it("contains attacker-controlled signature failures but leaves JWKS faults loud", async () => {
    const trusted = await keypair("trusted");
    const attacker = await keypair("attacker");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(trusted.jwks)),
    );
    const verifier = remoteJwksSignatureVerifier(uniqueJwksUri());

    await expect(verifier.verify(await sign(attacker, { sub: "forged" }))).resolves.toBe(false);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 503 })),
    );
    const unavailable = remoteJwksSignatureVerifier(uniqueJwksUri());
    await expect(unavailable.verify(await sign(trusted, { sub: "valid" }))).rejects.toThrow(
      "Expected 200 OK",
    );
  });

  it("does not follow a JWKS redirect to another host", async () => {
    const trusted = await keypair("trusted");
    const fetchJwks = vi.fn(async () => {
      return new Response(null, {
        status: 302,
        headers: { location: "https://169.254.169.254/jwks" },
      });
    });
    vi.stubGlobal("fetch", fetchJwks);
    const verifier = remoteJwksSignatureVerifier(uniqueJwksUri());

    await expect(verifier.verify(await sign(trusted, { sub: "valid" }))).rejects.toThrow(
      "Expected 200 OK",
    );
    expect(fetchJwks).toHaveBeenCalledOnce();
    const fetchedUrl = String(fetchJwks.mock.calls.at(0)?.at(0));
    expect(fetchedUrl).toContain("jwks.test");
    expect(fetchedUrl).not.toContain("169.254.169.254");
  });
});

type Keypair = {
  kid: string;
  privateKey: CryptoKey;
  jwks: { keys: Array<JsonWebKey & { kid: string }> };
};

async function keypair(kid: string): Promise<Keypair> {
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
  return {
    kid,
    privateKey: pair.privateKey,
    jwks: { keys: [{ ...publicJwk, kid }] },
  };
}

async function sign(pair: Keypair, claims: Record<string, unknown>): Promise<string> {
  const header = encode({ alg: "RS256", typ: "JWT", kid: pair.kid });
  const payload = encode(claims);
  const signingInput = `${header}.${payload}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    pair.privateKey,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${base64Url(new Uint8Array(signature))}`;
}

function encode(value: unknown): string {
  return base64Url(new TextEncoder().encode(JSON.stringify(value)));
}

function base64Url(value: Uint8Array): string {
  return btoa(String.fromCharCode(...value))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function uniqueJwksUri(): string {
  return `https://jwks.test/${crypto.randomUUID()}`;
}
