import { describe, expect, it } from "vitest";
import { hcRequestOptions, resolveControlPlaneUrl } from "./hc-client";

describe("hcRequestOptions", () => {
  it("omits headers when authorization is undefined (inherit the baked client)", () => {
    expect(hcRequestOptions({ baseUrl: "https://cp.test" })).toEqual({});
  });

  it("sets the Authorization header when a token is provided", () => {
    expect(hcRequestOptions({ baseUrl: "https://cp.test", authorization: "Bearer A" })).toEqual({
      headers: { authorization: "Bearer A" },
    });
  });

  it("emits a clearing header when authorization is explicitly null", () => {
    // hono deep-merges per-request options over construction options, so a bare
    // `{}` would leave a client-baked header in place; an empty value overrides.
    expect(hcRequestOptions({ baseUrl: "https://cp.test", authorization: null })).toEqual({
      headers: { authorization: "" },
    });
  });
});

describe("resolveControlPlaneUrl", () => {
  it("concatenates onto a base URL without a path prefix", () => {
    expect(resolveControlPlaneUrl(new URL("https://cp.test"), "/health").toString()).toBe(
      "https://cp.test/health",
    );
  });

  it("preserves a base URL path prefix (matches hono mergePath)", () => {
    expect(
      resolveControlPlaneUrl(new URL("https://gw.test/control-plane"), "/apps/a/flags").toString(),
    ).toBe("https://gw.test/control-plane/apps/a/flags");
  });

  it("collapses a trailing slash on the base path", () => {
    expect(resolveControlPlaneUrl(new URL("https://gw.test/cp/"), "/health").toString()).toBe(
      "https://gw.test/cp/health",
    );
  });
});
