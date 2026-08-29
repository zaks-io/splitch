import { describe, expect, it } from "vitest";
import { createMcpOperationAdapter } from "./mcp-operation-adapter";

/**
 * SPL-528 deleted the CLI's client-side selector resolution, so a user-typed
 * Flag key or App slug now travels straight into a URL path segment. `buildPath`
 * percent-encoding it is the only thing keeping a key like `a/b` from splitting
 * into two segments and addressing a different route. Nothing pinned that:
 * removing the `encodeURIComponent` call left the whole CLI suite green.
 */
async function urlFor(selector: string): Promise<string> {
  let forwarded: Request | undefined;
  const adapter = createMcpOperationAdapter({
    baseUrl: "https://control-plane.test",
    fetch: async (request) => {
      forwarded = request instanceof Request ? request : new Request(request);
      return Response.json(
        { code: "FLAG_NOT_FOUND", message: "no such Flag", details: {} },
        {
          status: 404,
        },
      );
    },
  });
  await adapter.callOperationById("flags_get", { appId: "app_local", flagId: selector });
  if (!forwarded) throw new Error("expected the adapter to forward a request");
  return forwarded.url;
}

describe("selector path encoding (SPL-528)", () => {
  it("keeps a slash inside the selector from becoming a path separator", async () => {
    expect(await urlFor("checkout/banner")).toBe(
      "https://control-plane.test/apps/app_local/flags/checkout%2Fbanner",
    );
  });

  it("keeps a traversal attempt inside one segment", async () => {
    expect(await urlFor("../../orgs")).toBe(
      "https://control-plane.test/apps/app_local/flags/..%2F..%2Forgs",
    );
  });

  it("encodes spaces, unicode, and query-delimiting characters", async () => {
    expect(await urlFor("dark launch")).toBe(
      "https://control-plane.test/apps/app_local/flags/dark%20launch",
    );
    expect(await urlFor("café")).toBe("https://control-plane.test/apps/app_local/flags/caf%C3%A9");
    // A bare `?` would otherwise start the query string and silently drop the
    // rest of the selector from the path.
    expect(await urlFor("a?b=c")).toBe("https://control-plane.test/apps/app_local/flags/a%3Fb%3Dc");
  });
});
