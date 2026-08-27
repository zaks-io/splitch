import { describe, expect, it, vi } from "vitest";
import { fetchTrustedJwks, jwksUrlError, normalizeJwksUrl, parseJwksUrl } from "./jwks-url";
import { CreateTrustedIdpRequestSchema } from "./schemas";

const PUBLIC = "https://idp.example.com/.well-known/jwks.json";

describe("JWKS URL policy", () => {
  it("accepts a public HTTPS JWKS URL and persists the normalized href", () => {
    expect(jwksUrlError(PUBLIC)).toBeNull();
    expect(normalizeJwksUrl("  HTTPS://IdP.Example.COM/.well-known/jwks.json  ")).toBe(PUBLIC);
    expect(parseJwksUrl(PUBLIC)).toEqual({ ok: true, href: PUBLIC });
  });

  it("accepts a public IPv4 and public IPv6 literal", () => {
    expect(jwksUrlError("https://8.8.8.8/jwks")).toBeNull();
    expect(jwksUrlError("https://[2001:4860:4860::8888]/jwks")).toBeNull();
  });

  it("rejects unsafe schemes and URL shape", () => {
    expect(jwksUrlError("http://idp.example.com/jwks")).toBe("jwks_uri must use https");
    expect(jwksUrlError("https://user:pass@idp.example.com/jwks")).toBe(
      "jwks_uri must not carry credentials",
    );
    expect(jwksUrlError("https://idp.example.com:8443/jwks")).toBe(
      "jwks_uri must not specify a port",
    );
    expect(jwksUrlError(`${PUBLIC}?x=1`)).toBe(
      "jwks_uri must not carry a query string or fragment",
    );
    expect(jwksUrlError(`${PUBLIC}#x`)).toBe("jwks_uri must not carry a query string or fragment");
    expect(jwksUrlError("not a url")).toBe("jwks_uri is not a valid URL");
  });

  it("rejects localhost, loopback, link-local, and private-network IPv4", () => {
    for (const url of [
      "https://localhost/jwks",
      "https://foo.localhost/jwks",
      "https://127.0.0.1/jwks",
      "https://10.0.0.1/jwks",
      "https://172.16.0.1/jwks",
      "https://192.168.1.1/jwks",
      "https://169.254.169.254/jwks",
      "https://0.0.0.0/jwks",
    ]) {
      expect(jwksUrlError(url), url).toBe("jwks_uri host is not allowed");
    }
  });

  it("rejects loopback, link-local, ULA, and IPv4-mapped IPv6", () => {
    for (const url of [
      "https://[::1]/jwks",
      "https://[::]/jwks",
      "https://[fe80::1]/jwks",
      "https://[fd12:3456:789a:1::1]/jwks",
      "https://[::ffff:127.0.0.1]/jwks",
      "https://[::ffff:169.254.169.254]/jwks",
      "https://[::ffff:10.0.0.1]/jwks",
      "https://[::127.0.0.1]/jwks",
      "https://[::7f00:1]/jwks",
      "https://[::a00:1]/jwks",
      "https://[::a9fe:a9fe]/jwks",
      "https://[64:ff9b::127.0.0.1]/jwks",
      "https://[2002:7f00:1::]/jwks",
    ]) {
      expect(jwksUrlError(url), url).toBe("jwks_uri host is not allowed");
    }
  });

  it("rejects percent-encoded localhost and loopback hosts after URL normalization", () => {
    expect(jwksUrlError("https://%6c%6f%63%61%6c%68%6f%73%74/jwks")).toBe(
      "jwks_uri host is not allowed",
    );
    // Encoded dots are either decoded to loopback or rejected as an invalid host.
    expect(jwksUrlError("https://127%2e0%2e0%2e1/jwks")).not.toBeNull();
  });

  it("rejects credentials hidden in the userinfo / host split", () => {
    expect(jwksUrlError("https://idp.example.com@127.0.0.1/jwks")).toBe(
      "jwks_uri must not carry credentials",
    );
  });
});

describe("CreateTrustedIdpRequestSchema jwks_uri", () => {
  it("normalizes a valid URI and rejects an unsafe one before CRUD", () => {
    const ok = CreateTrustedIdpRequestSchema.safeParse({
      issuer: "https://idp.example.com",
      jwks_uri: "  HTTPS://IdP.Example.COM/jwks  ",
      client_ids: ["cid"],
    });
    expect(ok.success).toBe(true);
    if (ok.success) {
      expect(ok.data.jwks_uri).toBe("https://idp.example.com/jwks");
    }

    const bad = CreateTrustedIdpRequestSchema.safeParse({
      issuer: "https://idp.example.com",
      jwks_uri: "https://169.254.169.254/jwks",
      client_ids: ["cid"],
    });
    expect(bad.success).toBe(false);
  });
});

describe("fetchTrustedJwks redirect behavior", () => {
  it("does not follow a redirect to a disallowed destination", async () => {
    const fetcher = vi.fn(async () => {
      return new Response(null, {
        status: 302,
        headers: { location: "https://169.254.169.254/latest/meta-data/" },
      });
    });

    const response = await fetchTrustedJwks(PUBLIC, { method: "GET" }, fetcher);

    expect(response.status).toBe(302);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledWith(PUBLIC, expect.objectContaining({ redirect: "manual" }));
  });

  it("refuses to fetch a disallowed URL", async () => {
    const fetcher = vi.fn();
    await expect(
      fetchTrustedJwks("https://127.0.0.1/jwks", { method: "GET" }, fetcher),
    ).rejects.toThrow("jwks_uri host is not allowed");
    expect(fetcher).not.toHaveBeenCalled();
  });
});
