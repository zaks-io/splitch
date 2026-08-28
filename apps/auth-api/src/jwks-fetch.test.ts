import { describe, expect, it, vi } from "vitest";
import { fetchTrustedJwks, type JwksFetch } from "./jwks-fetch";

const PUBLIC = "https://idp.example.com/.well-known/jwks.json";

describe("fetchTrustedJwks", () => {
  it("normalizes and validates the URL immediately before fetch", async () => {
    const fetcher = vi.fn<JwksFetch>(async () => Response.json({ keys: [] }));

    await fetchTrustedJwks(
      "  HTTPS://IdP.Example.COM/.well-known/jwks.json  ",
      { method: "GET" },
      { fetcher },
    );

    expect(fetcher).toHaveBeenCalledWith(PUBLIC, { method: "GET", redirect: "manual" });
  });

  it("returns a redirect without following its destination", async () => {
    const fetcher = vi.fn<JwksFetch>(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://169.254.169.254/latest/meta-data/" },
        }),
    );

    const response = await fetchTrustedJwks(PUBLIC, { method: "GET" }, { fetcher });

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://169.254.169.254/latest/meta-data/");
    expect(fetcher.mock.calls[0]?.[1]?.redirect).toBe("manual");
  });

  it("forwards the caller AbortSignal", async () => {
    const controller = new AbortController();
    const fetcher = vi.fn<JwksFetch>(async () => Response.json({ keys: [] }));

    await fetchTrustedJwks(PUBLIC, { method: "GET", signal: controller.signal }, { fetcher });

    expect(fetcher.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
  });

  it("rejects an unsafe URL before invoking fetch", async () => {
    const fetcher = vi.fn<JwksFetch>(async () => Response.json({ keys: [] }));

    await expect(
      fetchTrustedJwks("https://127.0.0.1/jwks", { method: "GET" }, { fetcher }),
    ).rejects.toThrow("jwks_uri host is not allowed");
    expect(fetcher).not.toHaveBeenCalled();
  });
});
